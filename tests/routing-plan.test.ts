import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { generateClashVergeScript } from "../src/generator";
import { parseManagedScript } from "../src/script-import";
import { classifyManagedScript } from "../src/managed-script-integrity";
import type { GeneratorSpec } from "../src/types";

export function routingSpec(): GeneratorSpec {
  return {
    targetProfile: { name: "Main", source: "https://main.example.test/synthetic" },
    parentGroupMode: "auto", parentGroupName: "", children: [], removedChildren: [],
    ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
    routing: {
      sources: [{ id: "target", kind: "target" }],
      outlets: [{ id: "outlet", kind: "existing", groupName: "PROXY" }],
      modules: [{ id: "ai", kind: "ai", enabled: true, outletId: "outlet", ruleSource: "category-ai-v1", customDomains: [] }],
    },
  };
}

export function applyRouting(spec: GeneratorSpec, input: Record<string, unknown>) {
  const result = generateClashVergeScript(spec);
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  const context = vm.createContext({ input: structuredClone(input) });
  vm.runInContext(`${result.fullScript}\nthis.output = main(input, "Main");`, context, { timeout: 1000 });
  return structuredClone(context.output) as Record<string, any>;
}

describe("saved routing through the public generator", () => {
  it("rejects unknown V3 fields, revisions, duplicate metadata, modified runtime and malformed plan input", () => {
    const script = generateClashVergeScript(routingSpec()).fullScript;
    const encoded = script.match(/CLASH_VERGE_KIT_MANAGEMENT_V3\n([A-Za-z0-9_-]+)/)![1]!;
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    for (const change of [
      { ...envelope, generatorRevision: "future" },
      { ...envelope, unexpected: true },
      { ...envelope, spec: { ...envelope.spec, routing: { ...envelope.spec.routing, unexpected: true } } },
    ]) {
      expect(parseManagedScript(script.replace(encoded, Buffer.from(JSON.stringify(change)).toString("base64url"))).ok).toBe(false);
    }
    expect(classifyManagedScript(script + "\nthrow new Error('untrusted');")).toBe("invalid");
    expect(parseManagedScript(script + script).ok).toBe(false);
    const malformed = routingSpec(); malformed.routing = { modules: null } as any;
    expect(generateClashVergeScript(malformed).valid).toBe(false);
  });
  it.each(["airport-filter", "", undefined])("isolates private aliases and restores the original include-all filter %s on disable", originalFilter => {
    const spec = routingSpec();
    spec.routing!.outlets = [{ id: "outlet", kind: "selected", groupName: "Chosen", nodes: [{ sourceId: "target", provider: "p", name: "node" }] }];
    const input = { "proxy-providers": { p: { type: "file", path: "./cache.yaml" } },
      "proxy-groups": [{ name: "Original", type: "select", "include-all": true,
        ...(originalFilter !== undefined ? { "exclude-filter": originalFilter } : {}) }], rules: ["MATCH,Original"] };
    const first = applyRouting(spec, input);
    const key = Object.keys(first["proxy-providers"]).find(key => key.startsWith("clash_verge_kit_nodes_"))!;
    const prefix = first["proxy-providers"][key].override["additional-prefix"];
    const excluded = first["proxy-groups"][0]["exclude-filter"].split("`");
    expect(excluded.some((pattern: string) => new RegExp(pattern).test(`${prefix}node`))).toBe(true);
    expect(excluded.every(Boolean)).toBe(true);
    if (originalFilter) expect(excluded[0]).toBe(originalFilter);
    expect(applyRouting(spec, first)).toEqual(first);
    spec.routing!.modules[0]!.enabled = false;
    expect(applyRouting(spec, first)).toEqual(input);
  });
  it("retains ownership of shared outlets and providers until their last external reference disappears", () => {
    const spec = routingSpec();
    spec.routing!.outlets = [{ id: "outlet", kind: "selected", groupName: "Chosen",
      nodes: [{ sourceId: "target", provider: null, name: "node" }] }];
    const input = { proxies: [{ name: "node", type: "http" }],
      "proxy-groups": [{ name: "Original", type: "select", proxies: ["DIRECT"] }], rules: ["MATCH,DIRECT"] };
    const first = applyRouting(spec, input);
    const key = Object.keys(first["rule-providers"])[0]!;
    first["proxy-groups"].push({ name: "External", type: "select", proxies: ["Chosen"] });
    first.rules.push(`RULE-SET,${key},DIRECT`);
    expect(applyRouting(spec, first)).toEqual(first);
    spec.routing!.modules[0]!.enabled = false;
    const shared = applyRouting(spec, first);
    expect(shared["clash-verge-kit-routing"].objects).toHaveLength(2);
    shared["proxy-groups"] = shared["proxy-groups"].filter((group: any) => group.name !== "External");
    shared.rules = shared.rules.filter((rule: string) => rule !== `RULE-SET,${key},DIRECT`);
    expect(applyRouting(spec, shared)).toEqual(input);
  });
  it.each(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"])("rejects built-in outlet name %s before delivery", name => {
    const spec = routingSpec();
    spec.routing!.outlets[0]!.groupName = name;
    expect(generateClashVergeScript(spec).valid).toBe(false);
  });
  it("combines selected target and child nodes while retaining nesting when routing is disabled", () => {
    const spec = routingSpec();
    spec.parentGroupMode = "manual"; spec.parentGroupName = "PROXY";
    spec.children = [{ id: "nested", groupName: "Nested", mode: "file", source: "./profiles/child.yaml" }];
    spec.routing!.sources.push({ id: "child", kind: "subscription", name: "Child", mode: "file", source: "./profiles/child.yaml" });
    spec.routing!.outlets = [{ id: "outlet", kind: "selected", groupName: "Chosen",
      nodes: [{ sourceId: "target", provider: null, name: "same[1]" }, { sourceId: "child", provider: null, name: "same[1]" }] }];
    const input = { proxies: [{ name: "same[1]", type: "http", server: "127.0.0.1", port: 1 }],
      "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["DIRECT"] }], rules: ["MATCH,PROXY"] };
    const output = applyRouting(spec, input);
    const outlet = output["proxy-groups"].find((group: any) => group.name === "Chosen");
    expect(outlet.use).toHaveLength(1);
    const isolated = output["proxy-providers"][outlet.use[0]];
    expect(isolated.path).toBe("./profiles/child.yaml");
    expect(new RegExp(outlet.filter).test("same[1]")).toBe(true);
    expect(new RegExp(outlet.filter).test(`${isolated.override["additional-prefix"]}same[1]`)).toBe(true);
    expect(output.proxies).toEqual(input.proxies);
    const nesting = output["proxy-groups"].find((group: any) => group.name === "Nested");
    spec.routing!.modules[0]!.enabled = false;
    const disabled = applyRouting(spec, output);
    expect(disabled["proxy-groups"].find((group: any) => group.name === "Nested")).toEqual(nesting);
    expect(disabled["proxy-groups"].some((group: any) => group.name === "Chosen")).toBe(false);
    expect(disabled["proxy-providers"][outlet.use[0]]).toBeUndefined();
  });
  it("isolates target providers with the same raw node name, preserving the original provider and its prefix", () => {
    const spec = routingSpec();
    spec.routing!.outlets = [{ id: "outlet", kind: "selected", groupName: "AI selected",
      nodes: [{ sourceId: "target", provider: "a", name: "same[1]" }] }];
    const provider = { type: "file", path: "./a.yaml", override: { "additional-prefix": "Original ", udp: true } };
    const output = applyRouting(spec, { "proxy-providers": { a: provider, b: { ...provider, path: "./b.yaml" } }, rules: ["MATCH,DIRECT"] });
    expect(output["proxy-providers"].a).toEqual(provider);
    const group = output["proxy-groups"][0];
    expect(group.use).toHaveLength(1);
    const isolated = output["proxy-providers"][group.use[0]];
    const alias = isolated.override["additional-prefix"];
    expect(new RegExp(group.filter).test(`${alias}same[1]`)).toBe(true);
    expect(new RegExp(group.filter).test("Original same[1]")).toBe(false);
    expect(new RegExp(group.filter).test(`${alias}same1`)).toBe(false);
    expect(isolated.override.udp).toBe(true);
    expect(isolated.filter).toBeUndefined();
  });
  it("selects exact static node names without renaming or falling back to unselected nodes", () => {
    const spec = routingSpec();
    spec.routing!.outlets = [{ id: "outlet", kind: "selected", groupName: "AI selected",
      nodes: [{ sourceId: "target", provider: null, name: "Tokyo+[1]" }] }];
    const nodes = [{ name: "Tokyo+[1]", type: "http", server: "127.0.0.1", port: 1 },
      { name: "Tokyo111", type: "http", server: "127.0.0.1", port: 2 }];
    const output = applyRouting(spec, { proxies: nodes, rules: ["MATCH,DIRECT"] });
    expect(output.proxies).toEqual(nodes);
    const group = output["proxy-groups"].find((item: any) => item.name === "AI selected");
    expect(nodes.filter(node => new RegExp(group.filter).test(node.name)).map(node => node.name)).toEqual(["Tokyo+[1]"]);
    expect(group["empty-fallback"]).toBe("REJECT");
    expect(group.proxies ?? []).not.toContain("REJECT");
    const missing = applyRouting(spec, { proxies: [nodes[1]], rules: ["MATCH,DIRECT"] });
    expect(missing.proxies.filter((node: any) => new RegExp(missing["proxy-groups"][0].filter).test(node.name))).toEqual([]);
  });
  it("changes and disables saved routing against current input, preserving shared and unrelated objects", () => {
    const spec = routingSpec();
    const input = { "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["DIRECT"] },
      { name: "OTHER", type: "select", proxies: ["REJECT"] }], rules: ["MATCH,DIRECT"] };
    const first = applyRouting(spec, input);
    const edited = structuredClone(spec);
    edited.routing!.outlets[0]!.groupName = "OTHER";
    const changed = applyRouting(edited, first);
    expect(changed.rules).toHaveLength(2);
    expect(changed.rules[0]).toMatch(/,OTHER$/);
    edited.routing!.modules[0]!.enabled = false;
    const latest = { ...input, rules: ["DOMAIN,ordinary.example.test,OTHER", "MATCH,OTHER"] };
    expect(applyRouting(edited, latest)).toEqual(latest);
    expect(applyRouting(edited, changed)).toEqual(input);
    const key = Object.keys(first["rule-providers"])[0]!;
    first.rules.push(`RULE-SET,${key},DIRECT`);
    const shared = applyRouting(edited, first);
    expect(shared["rule-providers"][key]).toEqual(first["rule-providers"][key]);
    expect(shared.rules).toEqual(["MATCH,DIRECT", `RULE-SET,${key},DIRECT`]);
  });
  it("delivers standalone AI to an existing group and round-trips V3 without changing ordinary routing", () => {
    const spec = routingSpec();
    const generated = generateClashVergeScript(spec);
    expect(generated.valid).toBe(true);
    expect(generated.fullScript).toContain("CLASH_VERGE_KIT_MANAGEMENT_V3");
    expect(parseManagedScript(generated.fullScript)).toEqual({ ok: true, spec, generatorRevision: "routing-v2" });
    expect(classifyManagedScript(generated.fullScript)).toBe("current-readable");
    const input = { "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["DIRECT"] }],
      rules: ["DOMAIN-SUFFIX,openai.com,DIRECT", "MATCH,DIRECT"], dns: { enable: false } };
    const output = applyRouting(spec, input);
    expect(output["proxy-groups"]).toEqual(input["proxy-groups"]);
    expect(output.rules.slice(1)).toEqual(input.rules);
    expect(output.rules[0]).toMatch(/^RULE-SET,[^,]+,PROXY$/);
    expect(Object.values(output["rule-providers"])[0]).toMatchObject({
      behavior: "domain", format: "text", interval: 86400,
      url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/category-ai-!cn.list",
    });
    expect(applyRouting(spec, output)).toEqual(output);
  });
});
