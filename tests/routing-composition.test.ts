import { createHash } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { createRemovedChildSubscription, generateClashVergeScript } from "../src/generator";
import { classifyManagedScript, inspectManagedScript } from "../src/managed-script-integrity";
import { normalizeManagedSpec, parseManagedScript } from "../src/script-import";
import type { GeneratorSpec } from "../src/types";

// Synthetic inputs only. Complete generated scripts must not become fixtures.
const httpSources = {
  target: "https://target.example.test/TARGET_HTTP_SENTINEL",
  child: "https://child.example.test/CHILD_HTTP_SENTINEL",
  routing: "https://routing.example.test/ROUTING_HTTP_SENTINEL",
  provider: "https://provider.example.test/PROVIDER_HTTP_SENTINEL",
};
const localPaths = ["./profiles/local-child.yaml", "./profiles/local-routing.yaml", "./profiles/local-provider.yaml"];

function baseSpec(): GeneratorSpec {
  return {
    targetProfile: { name: "Main", source: httpSources.target },
    parentGroupMode: "manual", parentGroupName: "PROXY", children: [], removedChildren: [],
    ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
  };
}

function withNesting(spec: GeneratorSpec): GeneratorSpec {
  spec.children = [
    { id: "http-child", groupName: "HTTP Nested", mode: "http", source: httpSources.child },
    { id: "file-child", groupName: "Local Nested", mode: "file", source: localPaths[0]! },
  ];
  spec.removedChildren = [createRemovedChildSubscription({ groupName: "Removed", mode: "file", source: "./profiles/removed.yaml" })];
  return spec;
}

function standaloneRouting(): GeneratorSpec {
  return { ...baseSpec(), routing: {
    sources: [{ id: "target", kind: "target" }],
    outlets: [{ id: "outlet", kind: "existing", groupName: "PROXY" }],
    modules: [{ id: "ai", kind: "ai", enabled: true, outletId: "outlet", ruleSource: "category-ai-v1", customDomains: ["work.example"] }],
  } };
}

function mixedRouting(): GeneratorSpec {
  const spec = withNesting(standaloneRouting());
  spec.routing!.sources.push(
    { id: "http-source", kind: "subscription", name: "HTTP Source", mode: "http", source: httpSources.routing,
      providers: [{ id: "remote-pool", mode: "http", source: httpSources.provider, interval: 3600 }] },
    { id: "file-source", kind: "subscription", name: "Local Source", mode: "file", source: localPaths[1]!,
      providers: [{ id: "local-pool", mode: "file", source: localPaths[2]!, interval: 0 }] },
  );
  spec.routing!.outlets = [{ id: "outlet", kind: "selected", groupName: "手选 AI", nodes: [
    { sourceId: "target", provider: null, name: "same-node" },
    { sourceId: "http-source", provider: "remote-pool", name: "same-node" },
    { sourceId: "file-source", provider: "local-pool", name: "same-node" },
  ] }];
  return spec;
}

function removedDisabledRouting(): GeneratorSpec {
  const spec = standaloneRouting();
  spec.removedChildren = withNesting(baseSpec()).removedChildren;
  spec.routing!.modules[0]!.enabled = false;
  spec.routing!.legacyAi = { ruleSource: "legacy-ai-v1", groupName: "Old AI", customDomains: ["old.example"] };
  return spec;
}

function servicesRouting(nested: boolean): GeneratorSpec {
  const spec = nested ? withNesting(baseSpec()) : baseSpec();
  spec.ai = { enabled: true, mode: "existing", groupName: "AI", customDomains: ["work.example"], ruleSource: "services-v1" };
  return spec;
}

const cases = [
  { name: "v3-standalone", spec: standaloneRouting(), localPaths: [] },
  { name: "v3-mixed-selected", spec: mixedRouting(), localPaths },
  { name: "v3-removed-disabled-legacy", spec: removedDisabledRouting(), localPaths: [] },
  { name: "v2-standalone", spec: servicesRouting(false), localPaths: [] },
  { name: "v2-nested", spec: servicesRouting(true), localPaths: [localPaths[0]!] },
].map(item => ({ ...item, spec: normalizeManagedSpec(item.spec)! }));

// Captured from the existing generator on 2026-09-12, before composition extraction.
// Keep these fixed: regenerating expectations would erase the compatibility evidence.
const baseline: Record<string, { full: { sha256: string; bytes: number }; masked: { sha256: string; bytes: number } }> = {
  "v3-standalone": {
    full: { sha256: "fd889e7a236848fbd9cd47d31a8a75a14220ce2ac594794d95206a636021dd2c", bytes: 15546 },
    masked: { sha256: "d483fe30d60945b7a7a75daf2d1520687301c99ce54d3273dfa9d9a9a1d2136d", bytes: 15523 },
  },
  "v3-mixed-selected": {
    full: { sha256: "1047ca1cae388163001b9ad3255fcce51eecf1a0bee26e9105b089260ed8c7bc", bytes: 29287 },
    masked: { sha256: "8286f8a33208061d57b04efa31827e449967bcbf7c32765e6dde657f031428d3", bytes: 29184 },
  },
  "v3-removed-disabled-legacy": {
    full: { sha256: "976a9d44b232a1db3fba42b100d54eba1e5c2fb6caa8c106ba9e3de4d2961c31", bytes: 23121 },
    masked: { sha256: "9c10d3f7125900e2ef4abc11abf55ef5e2bf35862c4425b44837b9b2c9414fb7", bytes: 23098 },
  },
  "v2-standalone": {
    full: { sha256: "70f756de9b0242aff03742f9b1fb86844b7e1e5a39d02b4de594229f10d35395", bytes: 4629 },
    masked: { sha256: "d3822d6efb332998adcfae965a566f8ebc7cee567137df2d76e6347887f9da23", bytes: 4606 },
  },
  "v2-nested": {
    full: { sha256: "7d1feff21c9777f06d535003994cc431ec5346565e05f57d1b064bc1496f4ed2", bytes: 16055 },
    masked: { sha256: "967db078304c4477e64d2be3a5eae068014011334376856cbda35e563f5c2a00", bytes: 16011 },
  },
};

function fingerprint(script: string) {
  return { sha256: createHash("sha256").update(script, "utf8").digest("hex"), bytes: Buffer.byteLength(script, "utf8") };
}

function metadata(script: string): { spec: GeneratorSpec } {
  const payload = script.match(/CLASH_VERGE_KIT_MANAGEMENT_V[23]\n([A-Za-z0-9_-]+)/)?.[1];
  expect(payload).toBeDefined();
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}

describe("frozen routing composition and preview", () => {
  it.each(cases)("preserves $name bytes, authenticated metadata and masked source handling", ({ name, spec, localPaths: expectedPaths }) => {
    const revision = name.startsWith("v3-") ? "routing-v1" : undefined;
    const generated = generateClashVergeScript(spec, revision ? { routingRevision: revision } : {});
    expect(generated.valid, JSON.stringify(generated.diagnostics)).toBe(true);
    expect({ full: fingerprint(generated.fullScript), masked: fingerprint(generated.maskedScript) }).toEqual(baseline[name]);
    expect(parseManagedScript(generated.fullScript)).toEqual({ ok: true, spec: normalizeManagedSpec(spec),
      ...(revision ? { generatorRevision: revision } : {}) });
    expect(classifyManagedScript(generated.fullScript)).toBe("current-readable");
    expect(inspectManagedScript(generated.fullScript)).toEqual({ authenticity: "current-readable", parsedSpec: normalizeManagedSpec(spec) });
    expect(() => new vm.Script(generated.maskedScript)).not.toThrow();

    const fullMetadata = metadata(generated.fullScript).spec;
    const maskedMetadata = metadata(generated.maskedScript).spec;
    const fullDecoded = JSON.stringify(fullMetadata);
    const maskedDecoded = JSON.stringify(maskedMetadata);
    for (const source of Object.values(httpSources)) {
      const sentinel = source.slice(source.lastIndexOf("/") + 1);
      expect(generated.maskedScript).not.toContain(sentinel);
      expect(maskedDecoded).not.toContain(sentinel);
      if (JSON.stringify(spec).includes(source)) expect(fullDecoded).toContain(source);
    }
    expect(maskedMetadata.targetProfile.source).toBe("https://redacted.invalid/target");
    for (const filePath of expectedPaths) {
      expect(maskedDecoded).toContain(filePath);
      expect(generated.maskedScript).toContain(filePath);
    }
    if (name === "v3-mixed-selected") {
      expect(maskedMetadata.children.map(child => child.source)).toEqual(["https://redacted.invalid/nested", localPaths[0]]);
      expect(maskedMetadata.routing!.sources[1]).toMatchObject({ source: "https://redacted.invalid/source-1",
        providers: [{ source: "https://redacted.invalid/source-1/provider-0" }] });
      expect(maskedMetadata.routing!.sources[2]).toMatchObject({ source: localPaths[1], providers: [{ source: localPaths[2] }] });
      expect(generated.maskedScript).toContain("https://••••••••••••");
    }
  });
});

describe("routing provider cache isolation", () => {
  function privateCachePath(spec: GeneratorSpec): string {
    const generated = generateClashVergeScript(spec);
    expect(generated.valid).toBe(true);
    const match = generated.fullScript.match(/"aliases": \{\s*.+?: "([0-9a-f]{24})"/);
    expect(match).not.toBeNull();
    return `clash_verge_kit_nodes_${match![1]}.yaml`;
  }

  it("uses a separate private cache for the same target provider in two subscriptions", () => {
    const first = standaloneRouting();
    first.routing!.outlets = [{ id: "outlet", kind: "selected", groupName: "Chosen", nodes: [
      { sourceId: "target", provider: "pool", name: "same-node" },
    ] }];
    const second = structuredClone(first);
    second.targetProfile = { name: "Other", source: "https://other.example.test/OTHER_TARGET_SENTINEL" };
    expect(privateCachePath(first)).not.toBe(privateCachePath(second));
    second.targetProfile.name = first.targetProfile.name;
    expect(privateCachePath(first)).not.toBe(privateCachePath(second));
    const generated = generateClashVergeScript(first);
    expect(parseManagedScript(generated.fullScript)).toEqual({ ok: true, spec: normalizeManagedSpec(first),
      generatorRevision: "routing-v2" });
    expect(classifyManagedScript(generated.fullScript)).toBe("current-readable");
  });

  it("uses a separate private cache when a child provider source changes", () => {
    const first = mixedRouting();
    first.routing!.outlets[0] = { id: "outlet", kind: "selected", groupName: "Chosen", nodes: [
      { sourceId: "http-source", provider: "remote-pool", name: "same-node" },
    ] };
    const second = structuredClone(first);
    const child = second.routing!.sources.find(source => source.id === "http-source");
    if (!child || child.kind !== "subscription") throw new Error("missing child source");
    child.providers![0]!.source = "https://other.example.test/OTHER_PROVIDER_SENTINEL";
    expect(privateCachePath(first)).not.toBe(privateCachePath(second));
  });
});
