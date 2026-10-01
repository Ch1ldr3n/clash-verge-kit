import { describe, expect, it } from "vitest";
import { inspectNewRoutingSource, inspectRoutingSources } from "../scripts/routing-source-catalog.ts";
import type { LocalProfileRepository } from "../scripts/local-profile-repository.ts";
import type { GeneratorSpec, RoutingSubscriptionSource } from "../src/types.ts";
import { collectSelectedNodes, verifySelectedNodes } from "../scripts/cli-routing-nodes.ts";
import { getCliMessages } from "../scripts/cli-messages.ts";
import { generateClashVergeScript } from "../src/generator.ts";
import type { CliWorkflowDependencies } from "../scripts/cli-workflow.ts";
import type { SubscriptionInspectionSummary } from "../src/subscription-inspection.ts";

const targetSource = "https://target.example.test/synthetic";
const childSource = "https://child.example.test/synthetic";

function draft(): GeneratorSpec {
  return {
    targetProfile: { name: "Target", source: targetSource },
    parentGroupMode: "auto", parentGroupName: "", children: [], removedChildren: [],
    ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
    routing: {
      sources: [{ id: "target", kind: "target" }, { id: "child", kind: "subscription", name: "Child",
        mode: "http", source: childSource,
        providers: [{ id: "pool", mode: "http", source: "https://pool.example.test/old", interval: 3600 }] }],
      outlets: [{ id: "outlet", kind: "selected", groupName: "Chosen", nodes: [
        { sourceId: "child", provider: "pool", name: "chosen" },
      ] }],
      modules: [{ id: "ai", kind: "ai", enabled: true, outletId: "outlet",
        ruleSource: "category-ai-v1", customDomains: [] }],
    },
  };
}

function profiles(live: RoutingSubscriptionSource): LocalProfileRepository {
  const inspection: SubscriptionInspectionSummary = { status: "available", name: "Target", nameSource: "local",
    origin: "local", format: "clash-yaml", selectGroups: [], suggestedGroup: null, nodeCount: 0, warnings: [] };
  return {
    async select(id) {
      return id === "target" ? { profileId: "target", name: "Target", source: targetSource,
        inspection } : null;
    },
    async findBySource() { return null; },
    async readRoutingSnapshot(lookup) {
      const child = "source" in lookup || lookup.profileId === "child";
      return { name: child ? "Child" : "Target", source: child ? childSource : targetSource,
        description: child ? live : { ...live, id: "target", name: "Target", source: targetSource },
        inspection: child ? { status: "partial", nodes: [
        { provider: "pool", name: "chosen" }, { provider: "unexpected", name: "other" }], failures: [] }
        : { status: "available", nodes: [], failures: [] } };
    },
    async list() { return []; },
    async installManagedScript() { throw new Error("read-only test"); },
  };
}

function dependencies(repository: LocalProfileRepository, choices: number[] = []): CliWorkflowDependencies {
  return { profiles: repository, generate: generateClashVergeScript, createChildId: () => "child",
    mihomoVersion: async () => "1.19.31", copyScript: async () => true,
    inspectRemote: async () => { throw new Error("no network"); },
    io: { setLanguage() {}, close() {}, writeLine() {}, ask: async () => "Chosen",
      confirm: async () => true, choose: async () => {
        const choice = choices.shift();
        if (choice === undefined) throw new Error("unexpected menu");
        return choice;
      } } };
}

describe("routing source catalog", () => {
  it("rejects a changed provider location at delivery and refreshes it for selection", async () => {
    const spec = draft();
    const live = { ...(spec.routing!.sources[1] as RoutingSubscriptionSource),
      providers: [{ id: "pool", mode: "http" as const, source: "https://pool.example.test/new", interval: 3600 }] };
    const repository = profiles(live);

    const delivery = await inspectRoutingSources(repository, spec, "target", "delivery");
    expect(delivery.changed).toEqual([{ sourceId: "child", provider: "pool" }]);
    expect(delivery.sources[1]).toEqual(spec.routing!.sources[1]);
    expect(delivery.available).toEqual([{ sourceId: "child", provider: "pool", name: "chosen" }]);
    expect(delivery.unknown).toEqual([{ sourceId: "child", provider: "unexpected" }]);

    const selection = await inspectRoutingSources(repository, spec, "target", "selection");
    expect(selection.changed).toEqual([]);
    expect(selection.sources[1]).toEqual(live);
    expect(spec.routing!.sources[1]).not.toEqual(live);
  });

  it("adds only nodes backed by the selected source descriptor", async () => {
    const live = draft().routing!.sources[1] as RoutingSubscriptionSource;
    expect(await inspectNewRoutingSource(profiles(live), "child", "child")).toEqual({
      source: live, nodes: [{ sourceId: "child", provider: "pool", name: "chosen" }], partial: true,
    });
  });

  it("distinguishes missing sources from failed reads and changed targets", async () => {
    const spec = draft();
    const repository = profiles(spec.routing!.sources[1] as RoutingSubscriptionSource);
    repository.readRoutingSnapshot = async () => null;
    expect((await inspectRoutingSources(repository, spec, "target", "delivery")).unknown).toEqual([]);
    repository.readRoutingSnapshot = async () => { throw new Error("unreadable"); };
    expect((await inspectRoutingSources(repository, spec, "target", "selection")).unknown).toEqual([
      { sourceId: "target", provider: null }, { sourceId: "child", provider: null },
    ]);
    repository.readRoutingSnapshot = async () => ({ name: "Changed", source: targetSource,
      description: null, inspection: { status: "available", nodes: [{ provider: null, name: "unexpected" }], failures: [] } });
    const changed = await inspectRoutingSources(repository, spec, "target", "delivery");
    expect(changed.available).toEqual([]);
    expect(changed.unknown).toHaveLength(2);
  });

  it("refuses child-only delivery when the target is changed, missing or unreadable", async () => {
    const spec = draft();
    const repository = profiles(spec.routing!.sources[1] as RoutingSubscriptionSource);
    const read = repository.readRoutingSnapshot!;
    for (const state of ["changed", "missing", "unreadable"]) {
      repository.readRoutingSnapshot = async (lookup, sourceId) => {
        if ("source" in lookup) return read(lookup, sourceId);
        if (state === "missing") return null;
        if (state === "unreadable") throw new Error("unreadable index");
        return { ...(await read(lookup, sourceId))!, name: "Another target" };
      };
      expect(await verifySelectedNodes(dependencies(repository), spec, "target", getCliMessages("en"))).toBe(false);
    }
  });

  it("requires deselecting a removed provider before returning an editable plan", async () => {
    const spec = draft();
    const outlet = spec.routing!.outlets[0]!;
    if (outlet.kind !== "selected") throw new Error("fixture outlet");
    outlet.nodes.unshift({ sourceId: "target", provider: null, name: "available" });
    const repository = profiles({ ...(spec.routing!.sources[1] as RoutingSubscriptionSource), providers: [] });
    const read = repository.readRoutingSnapshot!;
    repository.readRoutingSnapshot = async (lookup, sourceId) => ({ ...(await read(lookup, sourceId))!,
      inspection: { status: "available", nodes: "profileId" in lookup ? [{ provider: null, name: "available" }] : [], failures: [] } });
    const original = structuredClone(spec);
    // Available, removed selection, filter, add source, done.
    expect(await collectSelectedNodes(dependencies(repository, [4]), spec, "target", getCliMessages("en"))).toBeNull();
    expect(spec).toEqual(original);
    const next = await collectSelectedNodes(dependencies(repository, [1, 4]), spec, "target", getCliMessages("en"));
    expect(next).not.toBeNull();
    expect(generateClashVergeScript(next!).valid).toBe(true);
    expect(next!.routing!.sources).toEqual([{ id: "target", kind: "target" }]);
  });
});
