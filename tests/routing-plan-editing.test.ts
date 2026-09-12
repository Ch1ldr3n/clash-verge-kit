import { describe, expect, it } from "vitest";
import { editRoutingPlan, type RoutingPlanEdit } from "../src/routing-plan-editing";
import type { GeneratorSpec, RoutingPlan } from "../src/types";

function savedDraft(): GeneratorSpec {
  return {
    targetProfile: { name: "Main", source: "https://main.example.test/synthetic" },
    parentGroupMode: "manual", parentGroupName: "PROXY",
    children: [{ id: "nested", groupName: "Nested", mode: "file", source: "./profiles/child.yaml" }],
    removedChildren: [],
    ai: { enabled: true, mode: "existing", groupName: "Old AI", customDomains: ["+.work.example"] },
  };
}

function selection(): Extract<RoutingPlanEdit, { kind: "select-nodes" }> {
  return {
    kind: "select-nodes", groupName: "Selected AI",
    sources: [
      { id: "target", kind: "target" },
      { id: "child", kind: "subscription", name: "Child", mode: "file", source: "./profiles/child.yaml",
        providers: [{ id: "pool", mode: "file", source: "./profiles/pool.yaml", interval: 0 }] },
      { id: "unused", kind: "subscription", name: "Unused", mode: "file", source: "./profiles/unused.yaml" },
    ],
    nodes: [{ sourceId: "child", provider: "pool", name: "Same name" }],
  };
}

describe("routing plan editing", () => {
  it("keeps successive drafts and caller-owned node selections independent", () => {
    const original = savedDraft();
    const opened = editRoutingPlan(original, { kind: "open-saved" });
    const chosen = selection();
    const selected = editRoutingPlan(opened, chosen);
    const selectedSnapshot = structuredClone(selected);
    const existing = editRoutingPlan(selected, { kind: "use-existing", groupName: "Other AI" });
    const existingSnapshot = structuredClone(existing);
    const disabled = editRoutingPlan(existing, { kind: "disable" });

    expect(original).toEqual(savedDraft());
    expect(opened.routing?.outlets[0]).toMatchObject({ kind: "existing", groupName: "Old AI" });
    expect(selected.routing?.sources.map(source => source.id)).toEqual(["target", "child"]);
    expect(disabled.routing?.modules[0]?.enabled).toBe(false);
    expect(existing).toEqual(existingSnapshot);
    expect(selected).toEqual(selectedSnapshot);

    chosen.nodes[0]!.name = "Changed outside";
    (chosen.sources[1] as Extract<RoutingPlan["sources"][number], { kind: "subscription" }>).providers![0]!.source = "./profiles/changed.yaml";
    disabled.children[0]!.groupName = "Changed later";
    disabled.routing!.legacyAi!.customDomains.push("later.example");
    disabled.routing!.modules[0]!.customDomains.push("another.example");
    expect(selected).toEqual(selectedSnapshot);
    expect(existing).toEqual(existingSnapshot);
    expect(opened.children[0]!.groupName).toBe("Nested");
    expect(opened.routing?.legacyAi?.customDomains).toEqual(["work.example"]);
  });

  it("opens an existing V3 draft without reapplying migration or sharing its data", () => {
    const saved = editRoutingPlan(editRoutingPlan(savedDraft(), { kind: "open-saved" }), selection());
    const opened = editRoutingPlan(saved, { kind: "open-saved" });
    expect(opened).toEqual(saved);
    opened.routing!.legacyAi!.groupName = "Changed later";
    opened.children[0]!.groupName = "Changed later";
    expect(saved.routing?.legacyAi?.groupName).toBe("Old AI");
    expect(saved.children[0]!.groupName).toBe("Nested");
  });
});
