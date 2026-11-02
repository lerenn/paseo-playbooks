// Fails a pull request that changes what users install without bumping the
// version in package.json. Usage: node check-version.mjs <base-commit>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Files that reach a user's daemon or app, or the registry listing.
const SHIPPED = [
  /^index\.(client|server)\.tsx?$/,
  /^(client|server|shared|skills|assets)\//,
  /^paseo-plugin\.json$/,
  /^OVERVIEW(\.[\w-]+)?\.md$/,
];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const base = process.argv[2];
if (!base) fail("usage: check-version.mjs <base-commit>");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const parse = (v, where) => {
  const m = SEMVER.exec(v ?? "");
  if (!m) fail(`${where}: version "${v}" is not MAJOR.MINOR.PATCH`);
  return m.slice(1).map(Number);
};
const compare = (a, b) => a.map((x, i) => x - b[i]).find((d) => d !== 0) ?? 0;
function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const head = pkg.version;
if (lock.version !== head || lock.packages?.[""]?.version !== head) {
  fail(`package-lock.json version differs from package.json (${head}); bump with "npm version <patch|minor|major> --no-git-tag-version"`);
}

const baseVersion = JSON.parse(git("show", `${base}:package.json`)).version;
const order = compare(parse(head, "package.json"), parse(baseVersion, "base package.json"));
if (order < 0) fail(`version goes backwards: ${baseVersion} -> ${head}`);

const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
const shipped = changed.filter((f) => SHIPPED.some((re) => re.test(f)));
if (shipped.length === 0) {
  console.log(`No shipped files changed; version ${head} needs no bump.`);
} else if (order === 0) {
  fail(`Shipped files changed but the version is still ${head}. Bump it with "npm version <patch|minor|major> --no-git-tag-version". Changed: ${shipped.join(", ")}`);
} else {
  console.log(`Version bumped ${baseVersion} -> ${head} for: ${shipped.join(", ")}`);
}
