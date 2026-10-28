#!/usr/bin/env node
// Turn a repository created from the template into its own package. The template carries no
// versions; this script installs the current ones and derives every floor from them.
//
//   npm run init-package -- [--name <npm-name>] [--description "<text>"] [--refresh]
//
// 1. Identity: package name (default: the repository name), repository, homepage, bugs, README
//    title, LICENSE year. npm provenance requires `repository` to match the GitHub repository
//    that publishes. Owner and repository come from `git remote get-url origin`.
// 2. Toolchain: installs the current Pi, then pi-ai and typebox at the exact versions that Pi
//    depends on (exact dev pins, so the tests run against what Pi provides at runtime),
//    TypeScript, and @types/node on the Node floor's line.
// 3. Floors: the pi-coding-agent peer floor becomes the installed Pi version, and engines.node
//    becomes the installed Pi's own engines.node. CI reads both from package.json.
//
// Step 2 runs when the toolchain is missing, or again with --refresh.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const TEMPLATE = "pi-package-template";
const PI = "@earendil-works/pi-coding-agent";
/** Packages Pi provides to extensions at runtime; tested at the versions Pi itself depends on. */
const PROVIDED_BY_PI = ["@earendil-works/pi-ai", "typebox"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { name: { type: "string" }, description: { type: "string" }, refresh: { type: "boolean" } },
});

const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(origin);
if (!match) throw new Error(`origin is not a GitHub repository: ${origin}`);
const [, owner, repo] = match;
if (repo === TEMPLATE) throw new Error("origin is the template itself; run this in a repository created from it");

const name = values.name ?? repo;
if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) throw new Error(`"${name}" is not a valid npm package name`);

const readJson = file => JSON.parse(readFileSync(join(root, file), "utf8"));
const writeJson = (file, value) => writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`);
const edit = (file, change) => {
  const path = join(root, file);
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (after !== before) writeFileSync(path, after);
  console.log(`${after === before ? "unchanged" : "updated  "} ${file}`);
};
const npm = (...args) => execFileSync("npm", [...args, "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });

// 1. Identity
edit("package.json", text => {
  const pkg = JSON.parse(text);
  pkg.name = name;
  if (values.description) pkg.description = values.description;
  pkg.repository = { type: "git", url: `git+https://github.com/${owner}/${repo}.git` };
  pkg.homepage = `https://github.com/${owner}/${repo}#readme`;
  pkg.bugs = { url: `https://github.com/${owner}/${repo}/issues` };
  return `${JSON.stringify(pkg, null, 2)}\n`;
});
edit("README.md", text => text.replace(/^# .*$/m, `# ${name}`));
edit("LICENSE", text => text.replace(/Copyright \(c\) \d{4}/, `Copyright (c) ${new Date().getFullYear()}`));

// 2. Toolchain, at today's versions
const installed = Boolean(readJson("package.json").devDependencies?.[PI]);
if (!installed || values.refresh) {
  console.log("\ninstalling the current Pi, the pi-ai and typebox it uses, and TypeScript");
  npm("install", "--save-dev", "--save-exact", `${PI}@latest`);
  const piDeps = readJson(`node_modules/${PI}/package.json`).dependencies ?? {};
  const provided = PROVIDED_BY_PI.map(dep => {
    if (!piDeps[dep]) throw new Error(`${PI} no longer depends on ${dep}; update PROVIDED_BY_PI in scripts/init-package.mjs`);
    return `${dep}@${piDeps[dep]}`;
  });
  npm("install", "--save-dev", "--save-exact", ...provided);
  npm("install", "--save-dev", "typescript@latest");
}

// 3. Floors from what is installed
const pi = readJson(`node_modules/${PI}/package.json`);
const nodeFloor = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(pi.engines?.node ?? "");
if (!nodeFloor) throw new Error(`${PI} ${pi.version} declares engines.node "${pi.engines?.node}"; set engines.node and @types/node by hand`);
const pkg = readJson("package.json");
pkg.engines = { node: `>=${nodeFloor[1]}.${nodeFloor[2]}.${nodeFloor[3]}` };
pkg.peerDependencies = { ...pkg.peerDependencies, [PI]: `>=${pi.version}` };
writeJson("package.json", pkg);
console.log(`floors     Pi >=${pi.version}, Node ${pkg.engines.node}`);

// @types/node on the floor's minor line, so the type checker rejects newer Node APIs.
const typesRange = `~${nodeFloor[1]}.${nodeFloor[2]}.0`;
if (!installed || values.refresh || pkg.devDependencies?.["@types/node"] !== typesRange) {
  npm("install", "--save-dev", `@types/node@${typesRange}`);
}
// The floors changed package.json after the installs; bring the lockfile in step so npm ci accepts it.
npm("install", "--package-lock-only");

edit("package-lock.json", text => {
  const lock = JSON.parse(text);
  lock.name = name;
  if (lock.packages?.[""]) lock.packages[""].name = name;
  return `${JSON.stringify(lock, null, 2)}\n`;
});

console.log(`\n${name} -> github.com/${owner}/${repo}. Next: npm run check, write the extension, commit package-lock.json with it, push, then npm run bootstrap:npm.`);
