import { normalizeDomainSuffix } from "./generator.ts";
import type { GeneratorSpec, RoutingNodeReference, RoutingPlan } from "./types";

export type RoutingPlanEdit =
  | { kind: "open-saved" }
  | { kind: "use-existing"; groupName: string }
  | { kind: "select-nodes"; groupName: string; sources: RoutingPlan["sources"]; nodes: RoutingNodeReference[] }
  | { kind: "disable" };

/**
 * Edit a detached draft without changing saved-format normalization.
 * The CLI owns saved-script authentication and live selection checks;
 * the existing generator still validates the resulting spec.
 */
export function editRoutingPlan(draft: GeneratorSpec, edit: RoutingPlanEdit): GeneratorSpec {
  const next = structuredClone(draft);

  if (edit.kind === "disable") {
    next.ai.enabled = false;
    next.routing?.modules.forEach(module => { module.enabled = false; });
    return next;
  }

  if (edit.kind === "open-saved") {
    if (!next.routing && next.ai.enabled) {
      const customDomains = [...new Set(next.ai.customDomains
        .map(normalizeDomainSuffix).filter((value): value is string => value !== null))];
      const ruleSource = next.ai.ruleSource ?? "legacy-ai-v1";
      next.routing = {
        sources: [{ id: "target", kind: "target" }],
        outlets: [{ id: "outlet", kind: "existing", groupName: next.ai.groupName }],
        modules: [{ id: "ai", kind: "ai", enabled: true, outletId: "outlet", ruleSource, customDomains }],
        legacyAi: { ruleSource, groupName: next.ai.groupName, customDomains },
      };
      next.ai = { enabled: false, mode: "existing", groupName: "AI", customDomains: [] };
    }
    return next;
  }

  const previous = next.routing;
  const ruleSource = previous?.modules[0]?.ruleSource ?? "category-ai-v1";
  const customDomains = previous?.modules[0]?.customDomains
    ?? (edit.kind === "use-existing" ? next.ai.customDomains : []);
  const outletId = "outlet";
  let sources: RoutingPlan["sources"];
  let outlet: RoutingPlan["outlets"][number];

  if (edit.kind === "select-nodes") {
    const selection = structuredClone(edit);
    const usedSources = new Set(selection.nodes.map(node => node.sourceId));
    sources = selection.sources.filter(source => source.kind === "target" || usedSources.has(source.id));
    outlet = { id: outletId, kind: "selected", groupName: selection.groupName, nodes: selection.nodes };
  } else {
    sources = previous?.sources ?? [{ id: "target", kind: "target" }];
    outlet = { id: outletId, kind: "existing", groupName: edit.groupName };
  }

  next.ai = { enabled: false, mode: "existing", groupName: "AI", customDomains: [] };
  next.routing = {
    ...(previous?.legacyAi ? { legacyAi: previous.legacyAi } : {}),
    sources,
    outlets: [outlet],
    modules: [{ id: "ai", kind: "ai", enabled: true, outletId, ruleSource, customDomains }],
  };
  return next;
}
