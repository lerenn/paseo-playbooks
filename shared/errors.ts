/**
 * Splits a validation error into where it is ("step \"review\"", "steps \"a\", \"b\"", "inputs.x",
 * "step \"x\": on.y") and what is wrong, dropping the file path the card already shows.
 */
export function splitError(file: string, error: string): { where: string | null; message: string } {
  const rest = file && error.startsWith(`${file}: `) ? error.slice(file.length + 2) : error;
  const names = String.raw`"[^"]*"(?:, "[^"]*")*`;
  const head = String.raw`the manager(?: and steps? ${names})?|steps? ${names}|[a-z_]+(?:\.[\w-]+)?`;
  const match = new RegExp(String.raw`^((?:${head})(?:: [a-z_]+(?:\.[\w-]+)?)*): ([\s\S]+)$`).exec(rest);
  return match ? { where: match[1]!, message: match[2]! } : { where: null, message: rest };
}
