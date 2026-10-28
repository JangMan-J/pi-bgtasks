#!/usr/bin/env node
// Pack the package, install the tarball into a scratch project as `pi install npm:` would,
// and load it through Pi's real extension loader. This catches a broken `files` list, a missing
// runtime dependency, or an import that only resolves inside the repo.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const scratch = mkdtempSync(join(tmpdir(), "pi-package-smoke-"));
try {
  const npm = (args, cwd) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const tarball = join(scratch, npm(["pack", "--silent", "--pack-destination", scratch], root).trim().split("\n").pop());
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  npm(["install", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts", tarball], scratch);
  const installed = join(scratch, "node_modules", manifest.name);

  // The Pi under test is the one this repo develops against.
  const piName = dir => { try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name; } catch { return undefined; } };
  let piDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  while (piName(piDir) !== "@earendil-works/pi-coding-agent") {
    if (dirname(piDir) === piDir) throw new Error("Cannot find the installed @earendil-works/pi-coding-agent");
    piDir = dirname(piDir);
  }
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(piDir, "dist/core/extensions/loader.js")).href);

  const runtime = createExtensionRuntime();
  const entries = manifest.pi.extensions.map(entry => resolve(installed, entry));
  const loaded = await loadExtensions(entries, installed, undefined, runtime);
  if (loaded.errors.length) throw new Error(`Pi could not load the packed extension:\n${JSON.stringify(loaded.errors, null, 2)}`);

  const registered = {
    tools: loaded.extensions.flatMap(extension => [...extension.tools.keys()]),
    commands: loaded.extensions.flatMap(extension => [...extension.commands.keys()]),
    providers: runtime.pendingNativeProviderRegistrations.map(registration => registration.provider.id),
  };
  if (!Object.values(registered).some(list => list.length)) throw new Error("The packed extension loaded but registered no tools, commands, or providers");
  const summary = Object.entries(registered).filter(([, list]) => list.length).map(([kind, list]) => `${kind} ${list.join(", ")}`).join("; ");
  console.log(`${manifest.name}@${manifest.version}: packed tarball loads in Pi ${JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version}; ${summary}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
