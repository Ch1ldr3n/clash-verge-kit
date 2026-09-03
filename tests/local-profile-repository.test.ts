import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalProfileRepository } from "../scripts/local-profile-repository";
import { generateClashVergeScript } from "../src/generator";
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
