import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTextToClipboard } from "../scripts/cli-clipboard";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI clipboard", () => {
  it("passes Chinese text to the Windows clipboard command as UTF-16LE", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clash-verge-kit-clipboard-"));
    temporaryRoots.push(root);
    const receiver = path.join(root, "receiver.mjs");
    const output = path.join(root, "output.txt");
    await writeFile(receiver, `
import { writeFile } from "node:fs/promises";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString("utf16le");
await writeFile(process.argv[2], text, "utf8");
`, "utf8");
    const script = "// 中文代理组\nreturn config;";

    const copied = await copyTextToClipboard(script, {
      file: process.execPath,
      args: [receiver, output],
    });

    expect(copied).toBe(true);
    expect(await readFile(output, "utf8")).toBe(script);
  });

  it("reports failure when the clipboard command is unavailable", async () => {
    const copied = await copyTextToClipboard("sensitive", {
      file: "clash-verge-kit-missing-clipboard-command",
      args: [],
    });

    expect(copied).toBe(false);
  });
});
