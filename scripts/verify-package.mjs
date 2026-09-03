import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPackageFiles } from "./npm-pack-report.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm executable path is unavailable.");

const cacheDirectory = await mkdtemp(join(tmpdir(), "clash-verge-kit-npm-"));
try {
  const result = spawnSync(process.execPath, [
    npmCli,
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
    "--cache",
    cacheDirectory,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cacheDirectory },
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    throw new Error(`npm pack dry-run failed with exit code ${result.status ?? "unknown"}.`);
  }

  const report = JSON.parse(result.stdout);
  const files = extractPackageFiles(report);
  const expected = ["LICENSE", "README.en.md", "README.md", "dist/cli/cli.mjs", "package.json"];
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected package contents: ${JSON.stringify(files)}`);
  }

  process.stdout.write(`Package dry-run passed: ${files.join(", ")}\n`);
} finally {
  await rm(cacheDirectory, { recursive: true, force: true });
}
