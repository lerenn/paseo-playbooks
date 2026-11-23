import { detailEn } from "./i18n-detail";
import { graphEn } from "./i18n-graph";

/** The panel's `t` as the pure helpers take it: any key, optional values. The `t` from `useTranslation(messages)` fits. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tr = (key: any, options?: any) => string;

const english: Record<string, unknown> = { detail: detailEn, graph: graphEn };

/** English, for a helper called without `t` (and the unit tests): looks the key up in the English fragments and picks `_one` / `_other` by `count`. */
export const englishTr: Tr = (key: string, options: Record<string, string | number> = {}) => {
  const parent = key.split(".").slice(0, -1).reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], english) as Record<string, string>;
  const leaf = key.split(".").at(-1)!;
  const picked = typeof options.count === "number" ? (options.count === 1 ? parent[`${leaf}_one`] : parent[`${leaf}_other`]) ?? parent[leaf] : parent[leaf];
  return (picked ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ""));
};
