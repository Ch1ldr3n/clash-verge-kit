import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

const buildRoot = resolve("dist");
const allFiles = await walk(buildRoot);
const cliEntry = resolve(buildRoot, "cli", "cli.mjs");

if (!(await stat(cliEntry)).isFile()) {
  throw new Error("CLI build entry is missing.");
}
if (allFiles.length !== 1 || resolve(allFiles[0]) !== cliEntry) {
  throw new Error("CLI build must contain only dist/cli/cli.mjs.");
}

if (allFiles.some((file) => extname(file) === ".map")) {
  throw new Error("Source maps must not be published.");
}
const forbiddenMarkers = [
  "PASTE_SECOND_SUBSCRIPTION_URL_HERE",
  "token_test_should_not_ship",
  "subscription.example.test/private-token",
];
for (const file of allFiles) {
  const content = await readFile(file, "utf8");
  for (const marker of forbiddenMarkers) {
    if (content.includes(marker)) throw new Error(`Forbidden marker found in ${file}`);
  }
  if (content.includes("sourceMappingURL=")) throw new Error(`Source map reference found in ${file}`);
}

const cliBundle = await readFile(cliEntry, "utf8");
if (!cliBundle.startsWith("#!/usr/bin/env node")) throw new Error("CLI entry must keep its Node shebang.");

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
if (packageJson.engines?.node !== ">=22.12.0") {
  throw new Error("Package must require Node.js 22.12.0 or newer.");
}
if (packageJson.private !== false) {
  throw new Error("Package must be configured for public npm publication.");
}
if (packageJson.license !== "MIT") {
  throw new Error("Package must declare the MIT license.");
}
if (packageJson.repository?.url !== "git+https://github.com/Ch1ldr3n/clash-verge-kit.git") {
  throw new Error("Package must link to the public GitHub repository.");
}
const forbiddenPackages = [
  "@playwright/test",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
];
for (const dependency of forbiddenPackages) {
  if (dependency in (packageJson.dependencies ?? {}) || dependency in (packageJson.devDependencies ?? {})) {
    throw new Error(`Web-only package is still declared: ${dependency}`);
  }
}

const forbiddenScripts = ["app", "dev", "dev:local", "dev:open", "start", "test:e2e", "test:e2e:run"];
for (const script of forbiddenScripts) {
  if (script in (packageJson.scripts ?? {})) throw new Error(`Web-only npm script is still declared: ${script}`);
}
if (JSON.stringify(packageJson.bin) !== JSON.stringify({ "clash-verge-kit": "dist/cli/cli.mjs" })) {
  throw new Error("Package bin must expose only the CLI entry.");
}
if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist/cli/cli.mjs"])) {
  throw new Error("Package files must include only the CLI build.");
}

const cmdSource = await readFile(resolve("clash-verge-kit.cmd"), "utf8");
if (!/if\s+exist\s+"%~dp0dist\\cli\\cli\.mjs"/i.test(cmdSource)) {
  throw new Error("CMD entry must reuse an existing CLI build.");
}
if (!/node\s+"%~dp0dist\\cli\\cli\.mjs"/i.test(cmdSource)) {
  throw new Error("CMD entry must launch the built CLI with Node.");
}
if (!/call\s+npm\.cmd\s+run\s+build:cli/i.test(cmdSource)
  || /call\s+npm\s+run\s+build:cli/i.test(cmdSource)) {
  throw new Error("CMD entry must build the CLI when the bundle is missing.");
}
if (!/process\.versions\.node/.test(cmdSource)
  || !/if\s+%node_major%\s+EQU\s+22\s+if\s+%node_minor%\s+LSS\s+12/i.test(cmdSource)) {
  throw new Error("CMD entry must enforce the declared Node.js minimum version.");
}
if (/call\s+npm\s+run\s+cli(?:\s|$)/i.test(cmdSource)) {
  throw new Error("CMD entry must not rebuild the CLI on every launch.");
}
if (/browser|localhost|start-app|dist[\\/]server/i.test(cmdSource)) {
  throw new Error("CMD entry must not reference the retired Web runtime.");
}

process.stdout.write("CLI build privacy checks passed.\n");
