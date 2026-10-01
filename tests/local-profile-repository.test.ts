import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalProfileRepository } from "../scripts/local-profile-repository";
import { generateClashVergeScript } from "../src/generator";
import { parseManagedScript } from "../src/script-import";
import { inspectRoutingSources } from "../scripts/routing-source-catalog.ts";
import type { GeneratorSpec } from "../src/types";

const temporaryRoots: string[] = [];

const defaultScript = `// Define main function (script entry)
function main(config, profileName) {
  return config;
}
`;

async function createProfileFixture(script = defaultScript): Promise<{
  profilesFile: string;
  scriptFile: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "clash-verge-kit-repository-"));
  temporaryRoots.push(root);
  const profilesDirectory = path.join(root, "profiles");
  await mkdir(profilesDirectory, { recursive: true });
  const profilesFile = path.join(root, "profiles.yaml");
  await writeFile(profilesFile, `
current: Rexample
items:
  - uid: Rexample
    name: Example subscription
    type: remote
    url: https://subscription.example.test/private-token
    file: example.yaml
    option:
      script: sexample
  - uid: sexample
    type: script
    file: sexample.js
`, "utf8");
  await writeFile(path.join(profilesDirectory, "example.yaml"), `
proxies:
  - name: node-a
    type: ss
proxy-groups:
  - name: Main
    type: select
rules:
  - MATCH,Main
`, "utf8");
  const scriptFile = path.join(profilesDirectory, "sexample.js");
  await writeFile(scriptFile, script, "utf8");
  return { profilesFile, scriptFile };
}

function generatedScript(): string {
  const spec: GeneratorSpec = {
    targetProfile: {
      name: "Example subscription",
      source: "https://subscription.example.test/private-token",
    },
    parentGroupMode: "manual",
    parentGroupName: "Main",
    children: [{
      id: "child-1",
      groupName: "Child",
      mode: "http",
      source: "https://child.example.test/subscription",
    }],
    removedChildren: [],
    ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
  };
  return generateClashVergeScript(spec).fullScript;
}

function historicalCompactedScript(script: string): string {
  const historicalFunctions = [
    "clonePlain(value)",
    "escapeRegex(value)",
    "groupUsesProvider(group, providerKey)",
  ];
  const lines = script.replace(/\r\n/g, "\n").split("\n").flatMap((line) => {
    for (const signature of historicalFunctions) {
      const prefix = `function ${signature} { `;
      if (line.startsWith(prefix) && line.endsWith(" }")) {
        return [prefix.trimEnd(), line.slice(prefix.length, -2), "}"];
      }
    }
    return [line];
  });
  const start = lines.findIndex((line) => /^\/\* CLASH_VERGE_KIT_MANAGEMENT_V\d+$/.test(line));
  const end = lines.findIndex((line, index) => (
    index > start && /^CLASH_VERGE_KIT_MANAGEMENT_END \*\/$/.test(line)
  ));
  const runtime: string[] = [];
  let insideBlockComment = false;
  for (const line of [...lines.slice(0, start), ...lines.slice(end + 1)]) {
    const trimmed = line.trim();
    if (insideBlockComment) {
      if (trimmed.endsWith("*/")) insideBlockComment = false;
      continue;
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.endsWith("*/")) insideBlockComment = true;
      continue;
    }
    runtime.push(trimmed);
  }
  const packed: string[] = [];
  let current = "";
  for (const line of runtime) {
    if (!current) current = line;
    else if (current.length + line.length + 1 <= 160) current += ` ${line}`;
    else {
      packed.push(current);
      current = line;
    }
  }
  if (current) packed.push(current);
  return `${lines.slice(start, end + 1).join("\n")}\n${packed.join("\n")}`;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local profile repository", () => {
  it("preserves all old nesting relationships when adding AI to a combined script", async () => {
    const parsed = parseManagedScript(generatedScript());
    if (!parsed.ok) throw new Error("invalid-fixture");
    const originalSpec = { ...parsed.spec, children: [...parsed.spec.children, {
      id: "child-2", groupName: "Second", mode: "http" as const, source: "https://second.example.test/synthetic",
    }] };
    const original = generateClashVergeScript(originalSpec).fullScript;
    const { profilesFile, scriptFile } = await createProfileFixture(original);
    const repository = createLocalProfileRepository({ profileFileCandidates: () => [profilesFile] });
    const [target] = await repository.list();
    const ai = { enabled: true, mode: "existing" as const, groupName: "Main", customDomains: [], ruleSource: "services-v1" as const };
    const incomplete = generateClashVergeScript({ ...parsed.spec, ai }).fullScript;
    expect(await repository.installManagedScript(target!.id, incomplete)).toEqual({ status: "nesting-conflict" });
    expect(await readFile(scriptFile, "utf8")).toBe(original);
    const changedPrefix = generateClashVergeScript({ ...originalSpec, ai,
      children: originalSpec.children.map((child) => ({ ...child, nodePrefix: `[${child.groupName}]` })),
    }).fullScript;
    expect(await repository.installManagedScript(target!.id, changedPrefix)).toEqual({ status: "nesting-conflict" });
    const complete = generateClashVergeScript({ ...originalSpec, ai }).fullScript;
    expect(await repository.installManagedScript(target!.id, complete)).toEqual({ status: "written", targetIsCurrent: true });
    expect(await readFile(scriptFile, "utf8")).toBe(complete);
  });

  it("writes an AI-only script to an empty target without changing the subscription index", async () => {
    const { profilesFile, scriptFile } = await createProfileFixture();
    const indexBefore = await readFile(profilesFile, "utf8");
    const repository = createLocalProfileRepository({ profileFileCandidates: () => [profilesFile] });
    const [target] = await repository.list();
    const parsed = parseManagedScript(generatedScript());
    if (!parsed.ok) throw new Error("invalid-fixture");
    const incoming = generateClashVergeScript({ ...parsed.spec, parentGroupMode: "auto", parentGroupName: "", children: [],
      ai: { enabled: true, mode: "existing", groupName: "Main", customDomains: [], ruleSource: "services-v1" },
    });
    expect(await repository.installManagedScript(target!.id, incoming.fullScript))
      .toEqual({ status: "written", targetIsCurrent: true });
    expect(await readFile(scriptFile, "utf8")).toBe(incoming.fullScript);
    expect(await readFile(profilesFile, "utf8")).toBe(indexBefore);
  });

  it("rejects a generated AI script for a different target", async () => {
    const { profilesFile, scriptFile } = await createProfileFixture();
    const repository = createLocalProfileRepository({ profileFileCandidates: () => [profilesFile] });
    const [target] = await repository.list();
    const incoming = generateClashVergeScript({
      targetProfile: { name: "Another", source: "https://other.example.test/synthetic" },
      parentGroupMode: "auto", parentGroupName: "", children: [],
      ai: { enabled: true, mode: "existing", groupName: "Main", customDomains: [], ruleSource: "services-v1" },
    });
    expect(await repository.installManagedScript(target!.id, incoming.fullScript)).toEqual({ status: "invalid-script" });
    expect(await readFile(scriptFile, "utf8")).toBe(defaultScript);
  });

  it("does not replace an existing nesting script with an AI-only script", async () => {
    const original = generatedScript();
    const { profilesFile, scriptFile } = await createProfileFixture(original);
    const repository = createLocalProfileRepository({ profileFileCandidates: () => [profilesFile] });
    const [target] = await repository.list();
    const parsed = parseManagedScript(original);
    if (!parsed.ok) throw new Error("invalid-fixture");
    const incoming = generateClashVergeScript({ ...parsed.spec, parentGroupMode: "auto", parentGroupName: "", children: [],
      ai: { enabled: true, mode: "existing", groupName: "Main", customDomains: [], ruleSource: "services-v1" },
    });
    expect(incoming.valid).toBe(true);
    expect(await repository.installManagedScript(target!.id, incoming.fullScript))
      .toEqual({ status: "nesting-conflict" });
    expect(await readFile(scriptFile, "utf8")).toBe(original);
  });

  it("keeps the Kit historical-compact representation reproducible", () => {
    const digest = createHash("sha256")
      .update(historicalCompactedScript(generatedScript()))
      .digest("hex");

    expect(digest).toBe("482e0843c5e27c0764aac4d7b95b7b3261aae81e0cc399a64926b40bce9649f3");
  });

  it("lists opaque profiles and reveals a source only after selection", async () => {
    const { profilesFile } = await createProfileFixture();
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });

    const catalog = await repository.list();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      name: "Example subscription",
      status: "available",
      isCurrent: true,
    });
    expect(JSON.stringify(catalog)).not.toContain("private-token");

    const selection = await repository.select(catalog[0]!.id);
    expect(selection).toMatchObject({
      name: "Example subscription",
      source: "https://subscription.example.test/private-token",
    });
    expect(selection?.inspection.selectGroups).toEqual(["Main"]);
  });

  it("loads a manually specified Clash Verge Rev data directory for the current session", async () => {
    const { profilesFile } = await createProfileFixture();
    const repository = createLocalProfileRepository({ profileFileCandidates: () => [] });

    const result = await repository.addProfileLocation!(path.dirname(profilesFile));

    expect(result).toEqual({ status: "loaded", profileCount: 1 });
    expect(await repository.list()).toEqual([
      expect.objectContaining({ name: "Example subscription", isCurrent: true }),
    ]);
  });

  it("keeps a listed profile selectable when profiles.yaml is refreshed before selection", async () => {
    const { profilesFile } = await createProfileFixture();
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });
    const catalog = await repository.list();

    await writeFile(profilesFile, `
items:
  - uid: Rexample
    name: Example subscription
    type: remote
    url: https://subscription.example.test/private-token
    file: example.yaml
    option:
      script: sexample
  - uid: sexample
    type: script
    file: sexample.js
  - name: Newly added subscription
    type: remote
    url: https://new.example.test/private-token
    file: new.yaml
`, "utf8");
    const future = new Date(Date.now() + 2_000);
    await utimes(profilesFile, future, future);

    const selection = await repository.select(catalog[0]!.id);

    expect(selection).toMatchObject({
      name: "Example subscription",
      source: "https://subscription.example.test/private-token",
    });
  });

  it("writes a valid Kit-managed script only to the selected profile's linked script file", async () => {
    const { profilesFile, scriptFile } = await createProfileFixture();
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });
    const [profile] = await repository.list();
    const script = generatedScript();

    const result = await repository.installManagedScript(profile!.id, script);

    expect(result).toEqual({ status: "written", targetIsCurrent: true });
    expect(await readFile(scriptFile, "utf8")).toBe(script);
    expect(await readFile(profilesFile, "utf8")).not.toContain("CLASH_VERGE_KIT_MANAGEMENT");
  });

  it("refuses to overwrite an unrelated custom extension script", async () => {
    const customScript = "function main(config) { config.custom = true; return config; }";
    const { profilesFile, scriptFile } = await createProfileFixture(customScript);
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });
    const [profile] = await repository.list();

    const result = await repository.installManagedScript(profile!.id, generatedScript());

    expect(result).toEqual({ status: "custom-script-conflict" });
    expect(await readFile(scriptFile, "utf8")).toBe(customScript);
  });

  it("allows replacing a script already managed by Clash Verge Kit", async () => {
    const script = generatedScript();
    const { profilesFile, scriptFile } = await createProfileFixture(script);
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });
    const [profile] = await repository.list();

    const result = await repository.installManagedScript(profile!.id, script);

    expect(result).toEqual({ status: "written", targetIsCurrent: true });
    expect(await readFile(scriptFile, "utf8")).toBe(script);
  });

  it("allows replacing an unchanged historical compact Kit-managed script", async () => {
    const compactedScript = historicalCompactedScript(generatedScript());
    const { profilesFile, scriptFile } = await createProfileFixture(compactedScript);
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });
    const [profile] = await repository.list();
    const script = generatedScript();

    const result = await repository.installManagedScript(profile!.id, script);

    expect(result).toEqual({ status: "written", targetIsCurrent: true });
    expect(await readFile(scriptFile, "utf8")).toBe(script);
  });

  it("rejects a profiles directory junction instead of writing through it", async () => {
    const { profilesFile } = await createProfileFixture();
    const root = path.dirname(profilesFile);
    const profilesDirectory = path.join(root, "profiles");
    const outsideDirectory = path.join(root, "outside");
    await rm(profilesDirectory, { recursive: true, force: true });
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, "example.yaml"), "proxy-groups: []\n", "utf8");
    await writeFile(path.join(outsideDirectory, "sexample.js"), defaultScript, "utf8");
    await symlink(outsideDirectory, profilesDirectory, "junction");
    const repository = createLocalProfileRepository({ profileFileCandidates: () => [profilesFile] });
    const [profile] = await repository.list();

    const result = await repository.installManagedScript(profile!.id, generatedScript());

    expect(result).toEqual({ status: "unsafe-script-path" });
    expect(await readFile(path.join(outsideDirectory, "sexample.js"), "utf8")).toBe(defaultScript);
  });

  it("rejects scripts without valid Kit management metadata", async () => {
    const { profilesFile, scriptFile } = await createProfileFixture();
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });
    const [profile] = await repository.list();

    const result = await repository.installManagedScript(
      profile!.id,
      "function main(config) { return config; }",
    );

    expect(result).toEqual({ status: "invalid-script" });
    expect(await readFile(scriptFile, "utf8")).toBe(defaultScript);
  });

  it("rejects a non-canonical incoming script even when its management metadata is valid", async () => {
    const { profilesFile, scriptFile } = await createProfileFixture();
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });
    const [profile] = await repository.list();
    const modifiedScript = `// manually modified wrapper\n${generatedScript()}`;

    const result = await repository.installManagedScript(profile!.id, modifiedScript);

    expect(result).toEqual({ status: "invalid-script" });
    expect(await readFile(scriptFile, "utf8")).toBe(defaultScript);
  });

  it("rejects a historical compact script as new delivery input", async () => {
    const { profilesFile, scriptFile } = await createProfileFixture();
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });
    const [profile] = await repository.list();

    const result = await repository.installManagedScript(
      profile!.id,
      historicalCompactedScript(generatedScript()),
    );

    expect(result).toEqual({ status: "invalid-script" });
    expect(await readFile(scriptFile, "utf8")).toBe(defaultScript);
  });

  it("does not overwrite a modified managed script whose metadata is still valid", async () => {
    const modifiedScript = `// manually modified wrapper\n${generatedScript()}`;
    const { profilesFile, scriptFile } = await createProfileFixture(modifiedScript);
    const repository = createLocalProfileRepository({
      profileFileCandidates: () => [profilesFile],
    });
    const [profile] = await repository.list();

    const result = await repository.installManagedScript(profile!.id, generatedScript());

    expect(result).toEqual({ status: "custom-script-conflict" });
    expect(await readFile(scriptFile, "utf8")).toBe(modifiedScript);
  });
});

it("reopens an authenticated saved plan, backs up before saving and refuses edits based on an outdated read", async () => {
  const original = generatedScript();
  const fixture = await createProfileFixture(original);
  const repository = createLocalProfileRepository({ profileFileCandidates: () => [fixture.profilesFile] });
  const target = (await repository.list())[0]!;
  const saved = await repository.readManagedPlan!(target.id);
  expect(saved.status).toBe("saved");
  if (saved.status !== "saved") throw new Error("expected saved plan");
  const draft = saved.spec;
  draft.routing = { sources: [{ id: "target", kind: "target" }],
    outlets: [{ id: "outlet", kind: "existing", groupName: "Main" }],
    modules: [{ id: "ai", kind: "ai", enabled: true, outletId: "outlet", ruleSource: "category-ai-v1", customDomains: [] }] };
  const next = generateClashVergeScript(draft).fullScript;
  expect(await repository.installManagedScript(target.id, next, saved.revision)).toMatchObject({ status: "written" });
  const reopened = await repository.readManagedPlan!(target.id);
  expect(reopened).toMatchObject({ status: "saved", spec: { routing: draft.routing } });
  expect(await repository.installManagedScript(target.id, original, saved.revision)).toEqual({ status: "concurrent-change" });
  expect(await readFile(fixture.scriptFile, "utf8")).toBe(next);
  const backup = `${fixture.scriptFile}.kit-backup-${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
  expect(await readFile(backup, "utf8")).toBe(original);
});

it("inspects only node identities from safe static and provider snapshots, distinguishing unreadable providers", async () => {
  const fixture = await createProfileFixture();
  const directory = path.dirname(fixture.profilesFile);
  await writeFile(path.join(directory, "cached.yaml"), "proxies:\n  - name: same[1]\n    type: http\n    password: private-node-secret\n");
  await writeFile(path.join(directory, "profiles", "example.yaml"), "proxies:\n  - name: static+node\nproxy-providers:\n  a:\n    type: file\n    path: ./cached.yaml\n    override:\n      additional-prefix: Existing\n  b:\n    type: http\n    url: https://provider.example.test/secret\n    path: ./missing-cache.yaml\n");
  const repository = createLocalProfileRepository({ profileFileCandidates: () => [fixture.profilesFile] });
  const snapshot = await repository.readRoutingSnapshot!({ profileId: (await repository.list())[0]!.id }, "child");
  const nodes = snapshot!.inspection;
  expect(nodes).toMatchObject({ status: "partial", nodes: [
    { provider: null, name: "static+node" }, { provider: "a", name: "same[1]" },
  ], failures: [{ provider: "b", reason: "unreadable" }] });
  expect(JSON.stringify(nodes)).not.toContain("private-node-secret");
  expect(JSON.stringify(nodes)).not.toContain("https://provider.example.test/secret");
  expect(snapshot!.description?.providers).toEqual([
    { id: "a", mode: "file", source: "./cached.yaml", interval: 3600 },
    { id: "b", mode: "http", source: "https://provider.example.test/secret", interval: 3600 },
  ]);
});

it("refreshes routing snapshots and keeps readable target nodes separate from copyable child providers", async () => {
  const fixture = await createProfileFixture();
  const profileFile = path.join(path.dirname(fixture.profilesFile), "profiles", "example.yaml");
  const repository = createLocalProfileRepository({ profileFileCandidates: () => [fixture.profilesFile] });
  const target = (await repository.list())[0]!;
  await writeFile(profileFile, "proxies: []\nproxy-providers:\n  special:\n    type: http\n    url: https://provider.example.test/one\n    header: {X-Custom: [synthetic]}\n    payload: [{name: readable}]\n");
  const snapshot = await repository.readRoutingSnapshot!({ profileId: target.id }, "target");
  expect(snapshot!.inspection).toEqual({ status: "available", nodes: [{ provider: "special", name: "readable" }], failures: [] });
  expect(snapshot!.description?.providers).toEqual([]);

  await writeFile(profileFile, "proxies: [{name: new-static}]\nproxy-providers:\n  regular:\n    type: http\n    url: https://provider.example.test/two\n    payload: [{name: new-provider}]\n");
  const refreshed = await repository.readRoutingSnapshot!({ source: snapshot!.source }, "child");
  expect(refreshed!.inspection.nodes).toEqual([{ provider: null, name: "new-static" }, { provider: "regular", name: "new-provider" }]);
  expect(refreshed!.description?.providers).toEqual([{ id: "regular", mode: "http", source: "https://provider.example.test/two", interval: 3600 }]);
  expect(snapshot!.inspection.nodes).toEqual([{ provider: "special", name: "readable" }]);

  await writeFile(profileFile, "[invalid yaml");
  expect(await repository.readRoutingSnapshot!({ profileId: target.id }, "target")).toMatchObject({
    description: null, inspection: { status: "failed", nodes: [], failures: [{ provider: null, reason: "unreadable" }] },
  });
  expect(await repository.readRoutingSnapshot!({ profileId: "missing" }, "target")).toBeNull();
});

it("reports an unreadable profile index as unknown rather than missing routing nodes", async () => {
  const fixture = await createProfileFixture();
  const repository = createLocalProfileRepository({ profileFileCandidates: () => [fixture.profilesFile] });
  const target = (await repository.list())[0]!;
  const parsed = parseManagedScript(generatedScript());
  if (!parsed.ok) throw new Error("invalid fixture");
  const source = await readFile(fixture.profilesFile, "utf8");
  await writeFile(fixture.profilesFile, "[invalid index");
  const result = await inspectRoutingSources(repository, parsed.spec, target.id, "delivery");
  expect(result.unknown).toEqual([{ sourceId: "target", provider: null }]);
  await writeFile(fixture.profilesFile, source);
  expect((await inspectRoutingSources(repository, parsed.spec, target.id, "delivery")).unknown).toEqual([]);
});
