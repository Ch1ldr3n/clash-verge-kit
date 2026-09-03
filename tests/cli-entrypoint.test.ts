import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI-only entry points", () => {
  it("lets the CLI build own and clean the complete dist directory", async () => {
    const source = await readFile(new URL("../vite.cli.config.ts", import.meta.url), "utf8");
    expect(source).toMatch(/outDir:\s*["']dist["']/);
    expect(source).toMatch(/entryFileNames:\s*["']cli\/cli\.mjs["']/);
    expect(source).toMatch(/emptyOutDir:\s*true/);
    expect(source).toMatch(/copyPublicDir:\s*false/);
  });

  it("verifies the supported minimum Node version on Windows", async () => {
    const source = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(source).toMatch(/windows-cli:/);
    expect(source).toMatch(/runs-on:\s*windows-latest/);
    expect(source).toMatch(/node-version:\s*["']?22\.12\.0["']?/);
    expect(source).toMatch(/run:\s*npm run check/);
  });

  it("publishes only the CLI bundle", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      bin?: Record<string, string>;
      files?: string[];
      engines?: Record<string, string>;
    };

    expect(packageJson.bin).toEqual({ "clash-verge-kit": "dist/cli/cli.mjs" });
    expect(packageJson.files).toEqual(["dist/cli/cli.mjs"]);
    expect(packageJson.engines).toEqual({ node: ">=22.12.0" });
    expect(packageJson.scripts.cli).toContain("node dist/cli/cli.mjs");
    expect(packageJson.scripts["build:cli"]).toContain("vite.cli.config.ts");
    expect(Object.keys(packageJson.scripts)).not.toEqual(expect.arrayContaining([
      "app",
      "dev",
      "dev:local",
      "start",
      "test:e2e",
    ]));

    const packages = { ...packageJson.dependencies, ...packageJson.devDependencies };
    expect(Object.keys(packages)).not.toEqual(expect.arrayContaining([
      "@playwright/test",
      "@vitejs/plugin-react",
      "react",
      "react-dom",
    ]));
  });

  it("runs an existing CLI build directly and only builds on first launch", async () => {
    const source = await readFile(new URL("../clash-verge-kit.cmd", import.meta.url), "utf8");
    expect(source).toMatch(/if\s+exist\s+"%~dp0dist\\cli\\cli\.mjs"/i);
    expect(source).toMatch(/node\s+"%~dp0dist\\cli\\cli\.mjs"/i);
    expect(source).toMatch(/call\s+npm\.cmd\s+run\s+build:cli/i);
    expect(source).not.toMatch(/call\s+npm\s+run\s+build:cli/i);
    expect(source).toMatch(/process\.versions\.node/);
    expect(source).toMatch(/if\s+%node_major%\s+EQU\s+22\s+if\s+%node_minor%\s+LSS\s+12/i);
    expect(source).not.toMatch(/call\s+npm\s+run\s+cli(?:\s|$)/i);
    expect(source).not.toMatch(/browser|localhost|start-app|dist[\\/]server/i);
  });

  it.skipIf(process.platform !== "win32")("starts an existing build without rebuilding it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clash-verge-kit-launcher-"));
    temporaryRoots.push(root);
    const cliDirectory = path.join(root, "dist", "cli");
    const marker = path.join(root, "started.txt");
    await mkdir(cliDirectory, { recursive: true });
    await copyFile(new URL("../clash-verge-kit.cmd", import.meta.url), path.join(root, "clash-verge-kit.cmd"));
    await writeFile(
      path.join(cliDirectory, "cli.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(process.env.TEST_MARKER, "started");\n`,
      "utf8",
    );

    const result = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", path.join(root, "clash-verge-kit.cmd")],
      { cwd: root, encoding: "utf8", timeout: 5_000, env: { ...process.env, TEST_MARKER: marker } },
    );

    expect(result.status, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("started");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/首次运行|modules transformed/i);
  });

  it("keeps generated scripts readable instead of packing statements onto shared lines", async () => {
    const source = await readFile(new URL("../scripts/cli.ts", import.meta.url), "utf8");
    expect(source).toMatch(/generate:\s*generateClashVergeScript/);
    expect(source).not.toMatch(/compactManagedScript/);
    expect(source).toMatch(/getCliMessages\(selectedLanguage\)\.internalError/);
  });
});
