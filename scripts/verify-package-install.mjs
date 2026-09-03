import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPackageArchiveName } from "./npm-pack-report.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm executable path is unavailable.");

function runNpm(args, cwd, cacheDirectory) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: cacheDirectory,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    throw new Error(`npm ${args[0]} failed with exit code ${result.status ?? "unknown"}.`);
  }
  return result.stdout;
}

async function findInstalledCommand(prefixDirectory) {
  const candidates = process.platform === "win32"
    ? [
      join(prefixDirectory, "clash-verge-kit.cmd"),
      join(prefixDirectory, "bin", "clash-verge-kit.cmd"),
    ]
    : [join(prefixDirectory, "bin", "clash-verge-kit")];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next npm global-bin layout.
    }
  }
  throw new Error("Installed clash-verge-kit command was not found.");
}

function runInstalledCommand(command, cwd) {
  const result = process.platform === "win32"
    ? spawnSync(command, [], { shell: process.env.ComSpec ?? true, cwd, encoding: "utf8", input: "0\r\n" })
    : spawnSync(command, [], { cwd, encoding: "utf8", input: "0\n" });

  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`Installed CLI exited with code ${result.status ?? "unknown"}.`);
  }
  if (!output.includes("Choose language")) {
    process.stderr.write(output);
    throw new Error("Installed CLI did not reach the language menu.");
  }
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "clash-verge-kit-package-install-"));
const cacheDirectory = join(temporaryDirectory, "cache");
const packageDirectory = join(temporaryDirectory, "package");
const prefixDirectory = join(temporaryDirectory, "prefix");

try {
  await mkdir(packageDirectory, { recursive: true });
  const report = JSON.parse(runNpm([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packageDirectory,
    "--cache",
    cacheDirectory,
  ], process.cwd(), cacheDirectory));
  const archiveName = extractPackageArchiveName(report);
  const archivePath = join(packageDirectory, archiveName);

  runNpm([
    "install",
    "--global",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--prefix",
    prefixDirectory,
    "--cache",
    cacheDirectory,
    archivePath,
  ], temporaryDirectory, cacheDirectory);

  runInstalledCommand(await findInstalledCommand(prefixDirectory), temporaryDirectory);
  process.stdout.write("Package installation smoke test passed.\n");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
