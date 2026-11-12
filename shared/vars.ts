import type { VarDef, VarType, VarValue } from "./types";

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/** Variable paths used by a template, e.g. ["inputs.plan", "run.id"]. */
export function templateRefs(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/** If the template is exactly one placeholder, returns its path. */
export function singleRef(template: string): string | null {
  const match = /^\s*\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}\s*$/.exec(template);
  return match ? match[1]! : null;
}

export type TemplateContext = Record<string, unknown>;

/** A list value holds at most this many items, and at most this many characters of JSON. */
export const LIST_MAX_ITEMS = 200;
export const LIST_MAX_CHARS = 32_000;

/** One list element: a scalar, or a flat object of scalars (no nesting). */
export type ListItem = string | number | boolean | Record<string, string | number | boolean>;

/**
 * Reads a `list` value: a JSON array (or its JSON text) of scalars and flat objects of scalars, at most
 * LIST_MAX_ITEMS elements and LIST_MAX_CHARS characters. Returns the elements and their canonical JSON text.
 */
export function parseList(value: unknown): { ok: true; items: ListItem[]; text: string } | { ok: false; error: string } {
  let array: unknown = value;
  if (typeof value === "string") {
    if (value.length > LIST_MAX_CHARS) return { ok: false, error: `a list is at most ${LIST_MAX_CHARS} characters of JSON` };
    try {
      array = JSON.parse(value);
    } catch {
      return { ok: false, error: "expected a JSON array, e.g. [\"a\", \"b\"] or [{\"id\": 1}]" };
    }
  }
  if (!Array.isArray(array)) return { ok: false, error: "expected a JSON array, e.g. [\"a\", \"b\"] or [{\"id\": 1}]" };
  if (array.length > LIST_MAX_ITEMS) return { ok: false, error: `a list has at most ${LIST_MAX_ITEMS} items (got ${array.length})` };
  const scalar = (item: unknown): item is string | number | boolean => typeof item === "string" || typeof item === "number" || typeof item === "boolean";
  for (const [index, item] of array.entries()) {
    if (scalar(item)) continue;
    if (item !== null && typeof item === "object" && !Array.isArray(item) && Object.values(item).every(scalar)) continue;
    return { ok: false, error: `item ${index} must be a string, number, boolean or an object of those (no nesting)` };
  }
  const text = JSON.stringify(array);
  if (text.length > LIST_MAX_CHARS) return { ok: false, error: `a list is at most ${LIST_MAX_CHARS} characters of JSON` };
  return { ok: true, items: array as ListItem[], text };
}

/** Follows a dotted path. Keys may contain dots themselves (steps of a sub-playbook are "pr.investigate"). */
export function lookup(context: TemplateContext, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = context;
  let i = 0;
  while (i < parts.length) {
    if (current === null || typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    let j = i + 1;
    while (j <= parts.length && !(parts.slice(i, j).join(".") in record)) j++;
    if (j > parts.length) return undefined;
    current = record[parts.slice(i, j).join(".")];
    i = j;
  }
  return current;
}

/** Replaces each `{{ ref }}` for which `replace` returns text; other placeholders stay. */
export function replaceRefs(template: string, replace: (ref: string) => string | null): string {
  return template.replace(PLACEHOLDER, (match, ref: string) => replace(ref) ?? match);
}

/** Plain `{{ path }}` substitution. Unknown or empty values render as "(none)". */
export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => {
    const value = lookup(context, path);
    if (value === undefined || value === null || value === "") return "(none)";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** Value of a single-placeholder template, keeping its type; otherwise the rendered string. */
export function resolveValue(template: string, context: TemplateContext): VarValue | undefined {
  const ref = singleRef(template);
  if (ref !== null) {
    const value = lookup(context, ref);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    return undefined;
  }
  return renderTemplate(template, context);
}

/**
 * Checks and coerces a value against a declared type. Agents often send numbers and
 * booleans as strings, so "42" and "true" are accepted for number and boolean.
 */
export function coerceValue(def: Pick<VarDef, "type" | "values">, value: unknown): { ok: true; value: VarValue } | { ok: false; error: string } {
  switch (def.type) {
    case "string":
      if (typeof value === "string") return { ok: true, value };
      if (typeof value === "number" || typeof value === "boolean") return { ok: true, value: String(value) };
      return { ok: false, error: "expected a string" };
    case "number": {
      const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, error: "expected a number" };
    }
    case "boolean":
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "true" || value === "false") return { ok: true, value: value === "true" };
      return { ok: false, error: "expected true or false" };
    case "list": {
      const list = parseList(value);
      return list.ok ? { ok: true, value: list.text } : { ok: false, error: list.error };
    }
    case "enum":
      if (typeof value === "string" && (def.values ?? []).includes(value)) return { ok: true, value };
      return { ok: false, error: `expected one of ${(def.values ?? []).join(", ")}` };
  }
}

/** Whether a value of type `from` can feed a var of type `to`. */
export function typeCompatible(from: VarType | undefined, to: VarType | undefined): boolean {
  if (from === undefined || to === undefined) return true;
  if (from === to) return true;
  // Everything renders as text, so any type can feed a string.
  return to === "string";
}

/** Parses "30s", "45m", "2h" to milliseconds. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)\s*(s|m|h)$/.exec(text.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  return amount > 0 ? amount * unit : null;
}

export function formatValue(value: VarValue | undefined): string {
  return value === undefined || value === "" ? "(none)" : String(value);
}
