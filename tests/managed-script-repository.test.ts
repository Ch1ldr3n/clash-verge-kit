import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createLocalProfileRepository } from "../scripts/local-profile-repository";
import { generateClashVergeScript } from "../src/generator";
import { classifyManagedScript } from "../src/managed-script-integrity";
import { parseManagedScript } from "../src/script-import";
import type { GeneratorSpec } from "../src/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const target = { name: "Main", source: "https://main.example.test/synthetic" };

function plan(version: "v1" | "v2" | "v3", nested: boolean): GeneratorSpec {
  const spec: GeneratorSpec = {
    targetProfile: { ...target }, parentGroupMode: "manual", parentGroupName: "PROXY",
    children: nested ? [{ id: "child", groupName: "Nested", mode: "file", source: "./profiles/child.yaml" }] : [],
    removedChildren: [], ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
  };
  if (version === "v2") spec.ai = { ...spec.ai, enabled: true, ruleSource: "services-v1" };
  if (version === "v3") spec.routing = {
    sources: [{ id: "target", kind: "target" }],
    outlets: [{ id: "outlet", kind: "existing", groupName: "PROXY" }],
    modules: [{ id: "ai", kind: "ai", enabled: true, outletId: "outlet", ruleSource: "category-ai-v1", customDomains: [] }],
  };
  return spec;
}

function script(spec: GeneratorSpec): string {
  const generated = generateClashVergeScript(spec);
  expect(generated.valid).toBe(true);
  expect(classifyManagedScript(generated.fullScript)).toBe("current-readable");
  return generated.fullScript;
}

function profileIndex(scriptUid = "s1"): string {
  return stringify({ current: "p1", items: [
    { uid: "p1", type: "remote", name: target.name, url: target.source, file: "p1.yaml", option: { script: scriptUid } },
    { uid: scriptUid, type: "script", file: `${scriptUid}.js` },
  ] });
}

async function fixture(original: string) {
  const root = await mkdtemp(path.join(tmpdir(), "kit-managed-repository-"));
  roots.push(root);
  await mkdir(path.join(root, "profiles"));
  const indexPath = path.join(root, "profiles.yaml");
  const scriptPath = path.join(root, "profiles", "s1.js");
  await writeFile(indexPath, profileIndex(), "utf8");
  await writeFile(scriptPath, original, "utf8");
  const repository = createLocalProfileRepository({ profileFileCandidates: () => [indexPath] });
  const profileId = (await repository.list())[0]!.id;
  return { root, indexPath, scriptPath, repository, profileId };
}

describe("managed script repository rejection contracts", () => {
  it.each(["nesting", "target", "downgrade"] as const)("preserves %s conflict precedence for parseable scripts with modified bodies", async reason => {
    const previous = plan(reason === "nesting" ? "v1" : "v3", true);
    if (reason === "target") previous.targetProfile = { name: "Other", source: "https://other.example.test/synthetic" };
    const original = `${script(previous)}\n// modified body`;
    expect(parseManagedScript(original).ok).toBe(true);
    expect(classifyManagedScript(original)).toBe("invalid");
    const { repository, profileId, scriptPath, indexPath } = await fixture(original);
    const incoming = script(plan(reason === "downgrade" ? "v2" : "v3", false));

    expect(await repository.installManagedScript(profileId, incoming)).toEqual({
      status: reason === "nesting" ? "nesting-conflict" : "custom-script-conflict",
    });
    expect(await readFile(scriptPath, "utf8")).toBe(original);
    expect(await readFile(indexPath, "utf8")).toBe(profileIndex());
  });

  it.each(["index", "binding"] as const)("refuses an outdated editing revision after only the %s changes", async change => {
    const spec = plan("v3", true);
    const original = script(spec);
    const { root, repository, profileId, scriptPath, indexPath } = await fixture(original);
    const saved = await repository.readManagedPlan!(profileId);
    if (saved.status !== "saved") throw new Error("Expected a saved plan");
    const next = structuredClone(spec);
    next.routing!.modules[0]!.enabled = false;
    const linkedPath = change === "binding" ? path.join(root, "profiles", "s2.js") : scriptPath;
    if (change === "binding") await writeFile(linkedPath, original, "utf8");
    const changedIndex = change === "binding" ? profileIndex("s2") : `${profileIndex()}# external index change\n`;
    await writeFile(indexPath, changedIndex, "utf8");

    expect(await repository.installManagedScript(profileId, script(next), saved.revision)).toEqual({ status: "concurrent-change" });
    expect(await readFile(scriptPath, "utf8")).toBe(original);
    expect(await readFile(linkedPath, "utf8")).toBe(original);
    expect(await readFile(indexPath, "utf8")).toBe(changedIndex);
  });

  it("refuses a conflicting existing V3 backup without replacing either file", async () => {
    const spec = plan("v3", true);
    const original = script(spec);
    const { repository, profileId, scriptPath } = await fixture(original);
    const saved = await repository.readManagedPlan!(profileId);
    if (saved.status !== "saved") throw new Error("Expected a saved plan");
    const backupPath = `${scriptPath}.kit-backup-${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
    const conflictingBackup = "// different backup content\n";
    await writeFile(backupPath, conflictingBackup, "utf8");
    const next = structuredClone(spec);
    next.routing!.modules[0]!.enabled = false;

    expect(await repository.installManagedScript(profileId, script(next), saved.revision)).toEqual({ status: "write-failed" });
    expect(await readFile(scriptPath, "utf8")).toBe(original);
    expect(await readFile(backupPath, "utf8")).toBe(conflictingBackup);
  });
});
