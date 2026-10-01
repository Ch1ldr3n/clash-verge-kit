import type { GeneratorSpec, RoutingNodeReference, RoutingPlan, RoutingSubscriptionSource } from "../src/types.ts";
import type { LocalProfileRepository } from "./local-profile-repository.ts";
import type { RoutingNodeInspection } from "./routing-node-inspection.ts";

type RoutingSource = RoutingPlan["sources"][number];
type SourceFailure = { sourceId: string; provider: string | null };

function mapInspectedNodes(source: RoutingSource, inspection: RoutingNodeInspection) {
  const available: RoutingNodeReference[] = [];
  const unknown: SourceFailure[] = [];
  for (const node of inspection.nodes) {
    if (source.kind === "subscription" && node.provider !== null
      && !source.providers?.some(provider => provider.id === node.provider)) {
      unknown.push({ sourceId: source.id, provider: node.provider });
    } else {
      available.push({ sourceId: source.id, provider: node.provider, name: node.name });
    }
  }
  unknown.push(...inspection.failures.map(failure => ({ sourceId: source.id, provider: failure.provider })));
  return { available, unknown };
}

// Selection may refresh a saved child descriptor. Delivery must compare it to
// the saved descriptor and refuse a changed provider location instead.
export async function inspectRoutingSources(profiles: LocalProfileRepository, draft: GeneratorSpec,
  targetId: string, mode: "selection" | "delivery") {
  const sources = structuredClone(draft.routing?.sources ?? [{ id: "target", kind: "target" as const }]);
  const target = await profiles.readRoutingSnapshot?.({ profileId: targetId }, "target").catch(() => undefined);
  const targetVerified = Boolean(target && target.name === draft.targetProfile.name
    && target.source === draft.targetProfile.source && target.description !== null);
  const available: RoutingNodeReference[] = [];
  const unknown: SourceFailure[] = [];
  const changed: Array<{ sourceId: string; provider: string }> = [];
  for (let index = 0; index < sources.length; index++) {
    let source = sources[index]!;
    try {
      const snapshot = source.kind === "target" ? target
        : await profiles.readRoutingSnapshot?.({ source: source.source }, source.id);
      if (snapshot === null) continue;
      if (!snapshot) throw new Error("unreadable-source");
      if (source.kind === "target" && (snapshot.name !== draft.targetProfile.name || snapshot.source !== draft.targetProfile.source)) {
        throw new Error("changed-target");
      }
      const { inspection, description: current } = snapshot;
      if (mode === "selection" && source.kind === "subscription" && current) sources[index] = source = current;
      if (inspection.status === "failed") throw new Error("unreadable-source");
      if (source.kind === "subscription" && !current) throw new Error("unreadable-source");
      if (source.kind === "subscription") {
        for (const saved of source.providers ?? []) {
          const live = current?.providers?.find(provider => provider.id === saved.id);
          if (JSON.stringify(saved) !== JSON.stringify(live)) changed.push({ sourceId: source.id, provider: saved.id });
        }
      }
      const mapped = mapInspectedNodes(source, inspection);
      available.push(...mapped.available);
      unknown.push(...mapped.unknown);
    } catch {
      unknown.push({ sourceId: source.id, provider: null });
    }
  }
  return { sources, available, unknown, changed, targetVerified };
}

export async function inspectNewRoutingSource(profiles: LocalProfileRepository, profileId: string,
  sourceId: string): Promise<{ source: RoutingSubscriptionSource; nodes: RoutingNodeReference[]; partial: boolean } | null> {
  const snapshot = await profiles.readRoutingSnapshot?.({ profileId }, sourceId).catch(() => null);
  const source = snapshot?.description;
  const inspection = snapshot?.inspection;
  if (!source || !inspection || inspection.status === "failed") return null;
  const mapped = mapInspectedNodes(source, inspection);
  return { source, nodes: mapped.available, partial: mapped.unknown.length > 0 };
}
