import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { createLocalProfileRepository } from "../scripts/local-profile-repository";
import { runCliWorkflow } from "../scripts/cli-workflow";
import { BackRequestedError, type CliIO } from "../scripts/cli-io";
import { generateClashVergeScript } from "../src/generator";
import { parseManagedScript } from "../src/script-import";
import type { GeneratorSpec } from "../src/types";
import { verifySelectedNodes } from "../scripts/cli-routing-nodes.ts";
import { getCliMessages } from "../scripts/cli-messages.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function savedSpec(): GeneratorSpec {
  return { targetProfile: { name: "Main", source: "https://main.example.test/private-token" },
    parentGroupMode: "auto", parentGroupName: "", children: [], removedChildren: [],
    ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
    routing: { sources: [{ id: "target", kind: "target" }],
      outlets: [{ id: "outlet", kind: "existing", groupName: "PROXY" }],
      modules: [{ id: "ai", kind: "ai", enabled: true, outletId: "outlet", ruleSource: "category-ai-v1", customDomains: [] }] } };
}

async function fixture(spec = savedSpec()) {
  const root = await mkdtemp(path.join(tmpdir(), "kit-routing-workflow-")); roots.push(root);
  await mkdir(path.join(root, "profiles"));
  const index = path.join(root, "profiles.yaml");
  const scriptPath = path.join(root, "profiles", "s1.js");
  await writeFile(index, stringify({ current: "p1", items: [
    { uid: "p1", type: "remote", name: "Main", url: spec.targetProfile.source, file: "p1.yaml", option: { script: "s1" } },
    { uid: "s1", type: "script", file: "s1.js" },
  ] }));
  await writeFile(path.join(root, "profiles", "p1.yaml"), stringify({
    proxies: [{ name: "node+[1]", type: "http", server: "127.0.0.1", port: 1 }],
    "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["DIRECT"] }, { name: "OTHER", type: "select", proxies: ["REJECT"] }],
    rules: ["MATCH,PROXY"],
  }));
  await writeFile(scriptPath, generateClashVergeScript(spec).fullScript);
  return { root, scriptPath, repository: createLocalProfileRepository({ profileFileCandidates: () => [index] }) };
}

function input(steps: Array<number | string | boolean>): CliIO & { output: string[] } {
  const output: string[] = [];
  return { output, setLanguage() {}, close() {}, writeLine(line = "") { output.push(line); },
    async choose(_prompt, options) {
      const step = steps.shift();
      if (step === "back") throw new BackRequestedError();
      const index = typeof step === "string" ? options.findIndex(option => option.includes(step)) : step;
      if (typeof index !== "number" || index < 0 || index >= options.length) throw new Error(`Unexpected menu: ${options.join(" / ")}`);
      return index;
    },
    async confirm() { const step = steps.shift(); if (step === "back") throw new BackRequestedError(); if (typeof step !== "boolean") throw new Error("Expected confirmation"); return step; },
    async ask() { const step = steps.shift(); if (step === "back") throw new BackRequestedError(); if (typeof step !== "string") throw new Error("Expected input"); return step; },
  };
}

it("allows a readable target without its own nodes to use child-only selections", async () => {
  const { repository, root } = await fixture();
  const indexPath = path.join(root, "profiles.yaml");
  const { parse } = await import("yaml");
  const index = parse(await readFile(indexPath, "utf8"));
  const source = "https://child.example.test/only";
  index.items.push({ uid: "child", type: "remote", name: "Child", url: source, file: "child.yaml" });
  await writeFile(indexPath, stringify(index));
  await writeFile(path.join(root, "profiles", "p1.yaml"), stringify({
    "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["DIRECT"] }], rules: ["MATCH,PROXY"],
  }));
  await writeFile(path.join(root, "profiles", "child.yaml"), "proxies: [{name: Available, type: http}]\n");
  const spec = savedSpec();
  spec.routing!.sources.push({ id: "child", kind: "subscription", name: "Child", mode: "http", source });
  spec.routing!.outlets = [{ id: "outlet", kind: "selected", groupName: "Chosen",
    nodes: [{ sourceId: "child", provider: null, name: "Available" }] }];
  const target = (await repository.list()).find(item => item.name === "Main")!;
  const deps = { io: input([]), profiles: repository, generate: generateClashVergeScript,
    createChildId: () => "child", mihomoVersion: async () => "1.19.31", copyScript: async () => true,
    inspectRemote: async () => { throw new Error("no network"); } };
  expect(await verifySelectedNodes(deps, spec, target.id, getCliMessages("en"))).toBe(true);
  await writeFile(path.join(root, "profiles", "p1.yaml"), "[unreadable yaml");
  expect(await verifySelectedNodes(deps, spec, target.id, getCliMessages("en"))).toBe(false);
});

it("reopens, changes, writes and disables a saved plan through the real local repository", async () => {
  const { repository, scriptPath } = await fixture();
  const io = input([0, 0, "配置 AI 出口", 0, "OTHER", true, 0, 0, "back"]);
  const dependencies = { entryMode: "ai" as const, io, profiles: repository, generate: generateClashVergeScript,
    inspectRemote: async () => { throw new Error("No network needed"); }, copyScript: async () => true, createChildId: () => "child" };
  await runCliWorkflow(dependencies);
  const target = (await repository.list())[0]!;
  expect(await repository.readManagedPlan!(target.id)).toMatchObject({ status: "saved", spec: { routing: { outlets: [{ groupName: "OTHER" }] } } });
  const second = input([0, 0, "配置 AI 出口", 1, 0, 0, "back"]);
  await runCliWorkflow({ ...dependencies, io: second });
  expect(await repository.readManagedPlan!(target.id)).toMatchObject({ status: "saved", spec: { routing: { modules: [{ enabled: false }] } } });
  const saved = await readFile(scriptPath, "utf8");
  await runCliWorkflow({ ...dependencies, io: input([0, 0, "配置 AI 出口", 0, "PROXY", true, "back"]) });
  expect(await readFile(scriptPath, "utf8")).toBe(saved);
  expect(io.output.join("\n")).not.toContain("private-token");
});

it("selects target nodes, persists the selection, and explains missing nodes on the next inspection", async () => {
  const { repository, root } = await fixture();
  const io = input([0, 0, "配置 AI 出口", "手动选择", "node+[1]", "完成选择", "Chosen", true, 0, 0, "back"]);
  const dependencies = { entryMode: "ai" as const, io, profiles: repository, generate: generateClashVergeScript,
    mihomoVersion: async () => "1.19.29", inspectRemote: async () => { throw new Error("No network needed"); },
    copyScript: async () => true, createChildId: () => "child" };
  await runCliWorkflow(dependencies);
  const target = (await repository.list())[0]!;
  expect(await repository.readManagedPlan!(target.id)).toMatchObject({ status: "saved", spec: { routing: { outlets: [
    { kind: "selected", groupName: "Chosen", nodes: [{ sourceId: "target", provider: null, name: "node+[1]" }] },
  ] } } });
  await writeFile(path.join(root, "profiles", "p1.yaml"), "proxies: []\nproxy-groups: []\nrules: [MATCH,DIRECT]\n");
  const missing = input([0, 0, 0, "back"]);
  await runCliWorkflow({ ...dependencies, io: missing });
  expect(missing.output.join("\n")).toContain("全部已选节点缺失");
});

it("preserves the node draft when going back from filtering, naming and confirmation", async () => {
  const { repository } = await fixture();
  const io = input([0, 0, "配置 AI 出口", "手动选择", "node+[1]", "筛选", "back",
    "完成选择", "back", "完成选择", "Chosen", "back", "Chosen2", true, 0, 0, "back"]);
  await runCliWorkflow({ entryMode: "ai", io, profiles: repository, generate: generateClashVergeScript,
    mihomoVersion: async () => "1.19.29", inspectRemote: async () => { throw new Error("No network needed"); },
    copyScript: async () => true, createChildId: () => "child" });
  const target = (await repository.list())[0]!;
  expect(await repository.readManagedPlan!(target.id)).toMatchObject({ status: "saved", spec: { routing: {
    outlets: [{ groupName: "Chosen2", nodes: [{ name: "node+[1]" }] }],
  } } });
});

it("pages and searches in English, copies the latest selection, and leaves the saved file untouched", async () => {
  const { repository, root, scriptPath } = await fixture();
  const original = await readFile(scriptPath, "utf8");
  await writeFile(path.join(root, "profiles", "p1.yaml"), stringify({
    proxies: Array.from({ length: 22 }, (_, index) => ({ name: `Node-${String(index).padStart(2, "0")}`, type: "http" })),
    "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["DIRECT"] }], rules: ["MATCH,PROXY"],
  }));
  const io = input([1, 0, "Configure AI outlet", "Select nodes", "Next page", "Node-11", "Filter", "Node-21", "Node-21",
    "Finish selection", "Chosen", true, 0, 1, "back"]);
  let copied = "";
  await runCliWorkflow({ entryMode: "ai", io, profiles: repository, generate: generateClashVergeScript,
    mihomoVersion: async () => "1.19.29", inspectRemote: async () => { throw new Error("No network needed"); },
    copyScript: async script => { copied = script; return true; }, createChildId: () => "child" });
  expect(parseManagedScript(copied)).toMatchObject({ ok: true, spec: { routing: { outlets: [{ kind: "selected",
    nodes: [{ name: "Node-11" }, { name: "Node-21" }],
  }] } } });
  expect(await readFile(scriptPath, "utf8")).toBe(original);
  expect(io.output.join("\n")).not.toMatch(/private-token|[\u4e00-\u9fff]/);
});

it("keeps modified scripts read-only when reopening, without executing added JavaScript", async () => {
  const { repository, scriptPath } = await fixture();
  const changed = (await readFile(scriptPath, "utf8")) + '\nthrow new Error("untrusted-code-must-not-run");';
  await writeFile(scriptPath, changed);
  const io = input([0, 0, "back"]);
  await runCliWorkflow({ entryMode: "ai", io, profiles: repository, generate: generateClashVergeScript,
    inspectRemote: async () => { throw new Error("No network needed"); }, copyScript: async () => true, createChildId: () => "child" });
  expect(io.output.join("\n")).toContain("不支持安全编辑");
  expect(await readFile(scriptPath, "utf8")).toBe(changed);
});

it.each([undefined, "services-v1" as const])("migrates and disables authenticated legacy %s including historical suffix spellings", async ruleSource => {
  const legacy = savedSpec();
  delete legacy.routing;
  legacy.parentGroupMode = "manual"; legacy.parentGroupName = "PROXY";
  legacy.children = [{ id: "nested", groupName: "Nested", mode: "file", source: "./profiles/child.yaml" }];
  legacy.ai = { enabled: true, mode: "existing", groupName: "OTHER", customDomains: ["*.Example.COM"],
    ...(ruleSource ? { ruleSource } : {}) };
  const { repository, scriptPath } = await fixture(legacy);
  const before = await readFile(scriptPath, "utf8");
  await runCliWorkflow({ entryMode: "ai", io: input([0, 0, "配置 AI 出口", 1, 0, 0, "back"]),
    profiles: repository, generate: generateClashVergeScript, inspectRemote: async () => { throw new Error("No network needed"); },
    copyScript: async () => true, createChildId: () => "child" });
  const target = (await repository.list())[0]!;
  expect(await repository.readManagedPlan!(target.id)).toMatchObject({ status: "saved", spec: { routing: {
    modules: [{ enabled: false, customDomains: ["example.com"], ruleSource: ruleSource ?? "legacy-ai-v1" }],
  } } });
  const inputConfig = { "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["DIRECT"] },
    { name: "OTHER", type: "select", proxies: ["DIRECT"] }], rules: ["MATCH,PROXY"] };
  const apply = (script: string, config: object) => {
    const context = vm.createContext({ config: structuredClone(config) });
    vm.runInContext(`${script}\nthis.output = main(config, "Main");`, context, { timeout: 1000 });
    return structuredClone(context.output);
  };
  const disabled = await readFile(scriptPath, "utf8");
  const oldOutput = apply(before, inputConfig);
  expect(apply(disabled, oldOutput)).toEqual(apply(disabled, inputConfig));
});

it.each([undefined, "services-v1" as const])("preserves legacy %s through selecting nodes, changing outlet and disabling with explicit saves", async ruleSource => {
  const legacy = savedSpec();
  delete legacy.routing;
  legacy.parentGroupMode = "manual"; legacy.parentGroupName = "PROXY";
  legacy.children = [{ id: "nested", groupName: "Nested", mode: "file", source: "./profiles/child.yaml" }];
  legacy.ai = { enabled: true, mode: "existing", groupName: "OTHER", customDomains: ["*.Example.COM"],
    ...(ruleSource ? { ruleSource } : {}) };
  const { repository, scriptPath } = await fixture(legacy);
  const target = (await repository.list())[0]!;
  const original = await readFile(scriptPath, "utf8");
  expect(await repository.readManagedPlan!(target.id)).toMatchObject({ status: "saved", spec: { ai: { enabled: true } } });

  async function run(steps: Array<number | string | boolean>) {
    const drafts: GeneratorSpec[] = [];
    await runCliWorkflow({ entryMode: "ai", io: input([0, 0, ...steps]), profiles: repository,
      generate(spec) { drafts.push(structuredClone(spec)); return generateClashVergeScript(spec); },
      mihomoVersion: async () => "1.19.29", inspectRemote: async () => { throw new Error("No network needed"); },
      copyScript: async () => { throw new Error("This lifecycle saves explicitly"); }, createChildId: () => "child" });
    expect(drafts.length).toBeGreaterThan(0);
    return drafts.at(-1)!;
  }

  function expectPreserved(spec: GeneratorSpec, kind: "existing" | "selected", groupName: string, enabled: boolean) {
    expect(spec).toMatchObject({ targetProfile: legacy.targetProfile, parentGroupMode: "manual", parentGroupName: "PROXY",
      children: legacy.children, ai: { enabled: false }, routing: {
        legacyAi: { ruleSource: ruleSource ?? "legacy-ai-v1", groupName: "OTHER", customDomains: ["example.com"] },
        outlets: [{ kind, groupName }],
        modules: [{ enabled, ruleSource: ruleSource ?? "legacy-ai-v1", customDomains: ["example.com"] }],
      } });
    if (kind === "selected") expect(spec.routing?.outlets).toMatchObject([
      { nodes: [{ sourceId: "target", provider: null, name: "node+[1]" }] },
    ]);
  }

  expectPreserved(await run(["back"]), "existing", "OTHER", true);
  expect(await readFile(scriptPath, "utf8")).toBe(original);
  const selectNodes = ["配置 AI 出口", "手动选择", "node+[1]", "完成选择", "Chosen"];
  expectPreserved(await run([...selectNodes, false, "back"]), "existing", "OTHER", true);
  expect(await readFile(scriptPath, "utf8")).toBe(original);

  const stages: Array<{ actions: Array<number | string | boolean>; kind: "existing" | "selected"; name: string; enabled: boolean }> = [
    { actions: [...selectNodes, true], kind: "selected", name: "Chosen", enabled: true },
    { actions: ["配置 AI 出口", 0, "PROXY", true], kind: "existing", name: "PROXY", enabled: true },
    { actions: ["配置 AI 出口", 1], kind: "existing", name: "PROXY", enabled: false },
  ];
  for (const stage of stages) {
    const beforeSave = await readFile(scriptPath, "utf8");
    expectPreserved(await run([...stage.actions, "back"]), stage.kind, stage.name, stage.enabled);
    expect(await readFile(scriptPath, "utf8")).toBe(beforeSave);
    expectPreserved(await run([...stage.actions, 0, 0, "back"]), stage.kind, stage.name, stage.enabled);
    expect(await readFile(scriptPath, "utf8")).not.toBe(beforeSave);
    const saved = await repository.readManagedPlan!(target.id);
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("Expected an authenticated saved plan");
    expectPreserved(saved.spec, stage.kind, stage.name, stage.enabled);
    if (stage.kind === "selected") {
      const selectedScript = await readFile(scriptPath, "utf8");
      expectPreserved(await run(["配置 AI 出口", 0, "PROXY", false, "back"]), "selected", "Chosen", true);
      expect(await readFile(scriptPath, "utf8")).toBe(selectedScript);
    }
  }
});

it.each([null, "1.19.26", "1.19.27"])("rejects hand selection when the kernel is %s", async (version) => {
  const { repository, scriptPath } = await fixture();
  const original = await readFile(scriptPath, "utf8");
  const io = input([0, 0, "配置 AI 出口", "手动选择", "back"]);
  await runCliWorkflow({ entryMode: "ai", io, profiles: repository, generate: generateClashVergeScript,
    mihomoVersion: async () => version, inspectRemote: async () => { throw new Error("No network needed"); },
    copyScript: async () => true, createChildId: () => "child" });
  expect(io.output.join("\n")).toContain("1.19.29");
  expect(await readFile(scriptPath, "utf8")).toBe(original);
});

it("saves target and child selections separately and removes unused routing sources when editing", async () => {
  const { repository, root } = await fixture();
  const indexPath = path.join(root, "profiles.yaml");
  const { parse } = await import("yaml");
  const index = parse(await readFile(indexPath, "utf8"));
  index.items.push({ uid: "child", type: "remote", name: "Child", url: "https://child.example.test/private-child", file: "child.yaml" });
  await writeFile(indexPath, stringify(index));
  await writeFile(path.join(root, "profiles", "child.yaml"), "proxies:\n  - name: same[1]\n    type: http\n    password: private-node-secret\n");
  const io = input([0, 0, "配置 AI 出口", "手动选择", "node+[1]", "从子订阅", "Child", "same[1]", "完成选择", "Combined", true, 0, 0, "back"]);
  const deps = { entryMode: "ai" as const, io, profiles: repository, generate: generateClashVergeScript, mihomoVersion: async () => "1.19.29",
    inspectRemote: async () => { throw new Error("No network needed"); }, copyScript: async () => true, createChildId: () => "child" };
  await runCliWorkflow(deps);
  const target = (await repository.list()).find(item => item.name === "Main")!;
  expect(await repository.readManagedPlan!(target.id)).toMatchObject({ status: "saved", spec: { routing: {
    sources: [{ kind: "target" }, { id: "child", kind: "subscription", name: "Child" }],
    outlets: [{ kind: "selected", nodes: [{ sourceId: "target", name: "node+[1]" }, { sourceId: "child", name: "same[1]" }] }],
  } } });
  const edit = input([0, 0, "配置 AI 出口", "手动选择", "same[1]", "完成选择", "", true, 0, 0, "back"]);
  await runCliWorkflow({ ...deps, io: edit });
  expect(await repository.readManagedPlan!(target.id)).toMatchObject({ status: "saved", spec: { routing: { sources: [{ kind: "target" }] } } });
  expect(io.output.join("\n")).not.toMatch(/private-child|private-node-secret/);
});

it("refuses delivery when a saved child provider now points to a different source", async () => {
  const spec = savedSpec();
  spec.routing!.sources.push({ id: "child", kind: "subscription", name: "Child", mode: "http", source: "https://child.example.test/sub",
    providers: [{ id: "p", mode: "http", source: "https://old.example.test/nodes", interval: 3600 }] });
  spec.routing!.outlets = [{ id: "outlet", kind: "selected", groupName: "Chosen", nodes: [
    { sourceId: "target", provider: null, name: "node+[1]" }, { sourceId: "child", provider: "p", name: "Selected" },
  ] }];
  const { repository, root, scriptPath } = await fixture(spec);
  const { parse } = await import("yaml");
  const indexPath = path.join(root, "profiles.yaml");
  const index = parse(await readFile(indexPath, "utf8"));
  index.items.push({ uid: "child", type: "remote", name: "Child", url: "https://child.example.test/sub", file: "child.yaml" });
  await writeFile(indexPath, stringify(index));
  await writeFile(path.join(root, "profiles", "child.yaml"), stringify({ "proxy-providers": {
    p: { type: "http", url: "https://new.example.test/nodes", path: "./cache.yaml" },
  } }));
  await writeFile(path.join(root, "cache.yaml"), stringify({ proxies: [{ name: "Selected", type: "http" }] }));
  const original = await readFile(scriptPath, "utf8");
  const io = input([0, 0, 0, "back"]);
  await runCliWorkflow({ entryMode: "ai", io, profiles: repository, generate: generateClashVergeScript,
    mihomoVersion: async () => "1.19.29", inspectRemote: async () => { throw new Error("No network needed"); },
    copyScript: async () => { throw new Error("Must not deliver stale sources"); }, createChildId: () => "child" });
  expect(io.output.join("\n")).toContain("来源定位已变化");
  expect(await readFile(scriptPath, "utf8")).toBe(original);
});
