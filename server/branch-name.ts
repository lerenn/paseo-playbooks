/**
 * Why `name` cannot be a branch name, or null when it can. The rules of `git check-ref-format --branch`, plus
 * the one that matters most here: a leading `-` would be read by git as an option, not as a branch.
 */
export function branchNameProblem(name: string): string | null {
  if (name.length === 0) return "is empty";
  if (name.startsWith("-")) return "starts with `-`, which git would read as an option";
  if (name === "@") return "cannot be `@`";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f ~^:?*[\\]/.test(name)) return "contains a space, control character or one of ~ ^ : ? * [ \\";
  if (name.includes("..")) return "contains `..`";
  if (name.includes("@{")) return "contains `@{`";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return "has an empty path component (leading, trailing or doubled `/`)";
  if (name.endsWith(".")) return "ends with `.`";
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return "has a path component starting with `.`";
    if (part.endsWith(".lock")) return "has a path component ending with `.lock`";
  }
  return null;
}

/** Throws unless `name` is a valid branch name (see `branchNameProblem`). */
export function assertBranchName(name: string, what = "branch name"): void {
  const problem = branchNameProblem(name);
  if (problem) throw new Error(`${what} "${name}" ${problem}`);
}

/** Throws when `ref` (a branch, `origin/<branch>`, a commit-ish) starts with `-`: given to git as an argument it would be an option. */
export function assertNotOption(ref: string, what = "ref"): void {
  if (ref.startsWith("-")) throw new Error(`${what} "${ref}" starts with \`-\`, which git would read as an option`);
}
