import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPackageArchiveName } from "./npm-pack-report.mjs";
import { createHash } from "node:crypto";
import { inspectManagedScript } from "../src/managed-script-integrity.ts";

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

async function verifyWindowsSessions(prefix, root) {
  const directory = join(root, "appdata", "io.github.clash-verge-rev.clash-verge-rev");
  await mkdir(join(directory, "profiles"), { recursive: true });
  const index = "current: p1\nitems:\n  - {uid: p1, name: Synthetic CLI target, type: remote, url: 'https://cli.example.test/synthetic-source-secret', file: p1.yaml, option: {script: s1}}\n  - {uid: s1, type: script, file: s1.js}\n";
  await writeFile(join(directory, "profiles.yaml"), index);
  await writeFile(join(directory, "profiles", "p1.yaml"), "proxies: []\nproxy-groups:\n  - {name: OUTLET-A, type: select, proxies: [DIRECT]}\n  - {name: OUTLET-B, type: select, proxies: [REJECT]}\nrules: ['MATCH,OUTLET-A']\n");
  const script = join(directory, "profiles", "s1.js");
  await writeFile(script, "function main(config, profileName) { return config; }\n");
  const executable = join(prefix, "node_modules", "clash-verge-kit", "dist", "cli", "cli.mjs");
  async function session(steps) {
    await new Promise((resolve, reject) => {
      let pending = "", transcript = "", position = 0, failure;
      const child = spawn(process.execPath, [executable], {
        cwd: root, env: { ...process.env, APPDATA: join(root, "appdata") },
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const timer = setTimeout(() => { failure = Error(`CLI session timed out at step ${position}`); child.kill(); }, 20000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.stdin.on("error", error => { failure ??= error; });
      child.stderr.on("data", () => { failure ??= Error("Installed CLI wrote to stderr"); });
      child.stdout.on("data", chunk => {
        pending += chunk; transcript += chunk;
        if (!/(?:> |\[y\/n\/0\] )$/.test(pending)) return;
        const step = steps[position];
        if (!step || !pending.includes(step[0])) {
          failure = Error(`Unexpected CLI prompt at step ${position}; expected ${step?.[0] ?? "exit"}`);
          child.kill(); return;
        }
        position++; pending = "";
        child.stdin.write(step[1] + "\n");
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        try {
          assert.equal(code, 0); assert.equal(position, steps.length);
          assert.ok(!transcript.includes("synthetic-source-secret"));
          assert.ok(!transcript.includes("function main("));
          resolve();
        } catch (error) { reject(error); }
      });
    });
  }
  const enter = [["Choose language", "2"], ["AI routing only", "2"], ["Synthetic CLI target", "1"]];
  const deliver = [["Choose the next step", "1"], ["Write to Clash Verge Rev", "1"], ["Write complete", "0"]];
  const chooseGroup = group => [["Choose an existing target outlet group", "1"], ["OUTLET-B", group], ["Use this group?", "y"]];
  async function save(steps) {
    const old = await readFile(script, "utf8");
    await session(steps);
    const saved = inspectManagedScript(await readFile(script, "utf8"));
    assert.equal(saved.authenticity, "current-readable");
    const hash = createHash("sha256").update(old).digest("hex").slice(0, 16);
    assert.equal(await readFile(`${script}.kit-backup-${hash}`, "utf8"), old);
    return saved.parsedSpec;
  }
  let saved = await save([...enter, ...chooseGroup("1"), ...deliver]);
  assert.equal(saved.routing.outlets[0].groupName, "OUTLET-A");
  saved = await save([...enter, ["Choose the next step", "5"], ...chooseGroup("2"), ...deliver]);
  assert.equal(saved.routing.outlets[0].groupName, "OUTLET-B");
  saved = await save([...enter, ["Choose the next step", "5"], ["Disable AI routing", "2"], ...deliver]);
  assert.equal(saved.routing.modules[0].enabled, false);
  const beforeCancel = await readFile(script, "utf8");
  await session([...enter, ["Choose the next step", "0"]]);
  assert.equal(await readFile(script, "utf8"), beforeCancel);
  assert.equal(await readFile(join(directory, "profiles.yaml"), "utf8"), index);
  console.log("PASS installed Windows CLI: create/write, reopen/edit, disable, cancel, exact backups and private default output");
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
  if (process.platform === "win32") await verifyWindowsSessions(prefixDirectory, temporaryDirectory);
  process.stdout.write("Package installation smoke test passed.\n");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
