import type { GeneratorSpec, RoutingNodeReference } from "../src/types.ts";
import { routingGroupName } from "../src/routing-plan.ts";
import { BackRequestedError } from "./cli-io.ts";
import type { CliWorkflowDependencies } from "./cli-workflow.ts";
import { getCliMessages } from "./cli-messages.ts";
import { editRoutingPlan } from "../src/routing-plan-editing.ts";
import { supportsSelectedRouting } from "./mihomo-capability.ts";

type Copy = ReturnType<typeof getCliMessages>;
const identity = (node: RoutingNodeReference) => JSON.stringify([node.sourceId, node.provider, node.name]);

async function inspectSources(deps: CliWorkflowDependencies, draft: GeneratorSpec, targetId: string) {
  const available: RoutingNodeReference[] = [];
  const unknown: Array<{ sourceId: string; provider: string | null }> = [];
  const changed: Array<{ sourceId: string; provider: string }> = [];
  for (const source of draft.routing?.sources ?? [{ id: "target", kind: "target" as const }]) {
    try {
      const profile = source.kind === "target" ? await deps.profiles.select(targetId) : await deps.profiles.findBySource(source.source);
      if (!profile) continue;
      if (source.kind === "target" && (profile.name !== draft.targetProfile.name || profile.source !== draft.targetProfile.source)) throw new Error("changed-target");
      const inspection = await deps.profiles.inspectRoutingNodes?.(profile.profileId);
      if (!inspection || inspection.status === "failed") throw new Error("unreadable-source");
      const current = source.kind === "subscription" ? await deps.profiles.describeRoutingSource?.(profile.profileId, source.id) : null;
      if (source.kind === "subscription" && !current) throw new Error("unreadable-source");
      if (source.kind === "subscription") {
        for (const saved of source.providers ?? []) {
          const live = current?.providers?.find(provider => provider.id === saved.id);
          if (JSON.stringify(saved) !== JSON.stringify(live)) changed.push({ sourceId: source.id, provider: saved.id });
        }
      }
      for (const node of inspection.nodes) {
        if (source.kind === "subscription" && node.provider !== null && !source.providers?.some(provider => provider.id === node.provider)) {
          unknown.push({ sourceId: source.id, provider: node.provider });
        } else available.push({ sourceId: source.id, provider: node.provider, name: node.name });
      }
      unknown.push(...inspection.failures.map(failure => ({ sourceId: source.id, provider: failure.provider })));
    } catch { unknown.push({ sourceId: source.id, provider: null }); }
  }
  return { available, unknown, changed };
}

export async function verifySelectedNodes(deps: CliWorkflowDependencies, draft: GeneratorSpec, targetId: string, copy: Copy): Promise<boolean> {
  const selected = draft.routing?.outlets.filter(outlet => outlet.kind === "selected"
    && draft.routing!.modules.some(module => module.enabled && module.outletId === outlet.id)) ?? [];
  if (!selected.length) return true;
  if (!supportsSelectedRouting(await deps.mihomoVersion?.() ?? null)) { deps.io.writeLine(copy.kernelUnsupported); return false; }
  const inspection = await inspectSources(deps, draft, targetId);
  let valid = true;
  for (const outlet of selected) {
    if (outlet.kind !== "selected") continue;
    if (outlet.nodes.some(node => inspection.changed.some(item => item.sourceId === node.sourceId && item.provider === node.provider))) {
      deps.io.writeLine(copy.nodeSourceChanged); valid = false;
    }
    const present = outlet.nodes.filter(node => inspection.available.some(item => identity(item) === identity(node)));
    const unknown = outlet.nodes.filter(node => !present.includes(node) && inspection.unknown.some(failure => failure.sourceId === node.sourceId
      && (failure.provider === null || failure.provider === node.provider)));
    const missing = outlet.nodes.filter(node => !present.includes(node) && !unknown.includes(node));
    deps.io.writeLine(copy.nodesSummary(present.length, missing.length, unknown.length));
    missing.forEach(node => {
      const source = draft.routing!.sources.find(source => source.id === node.sourceId)!;
      deps.io.writeLine(copy.nodeMissing(`${node.name} (${source.kind === "target" ? draft.targetProfile.name : source.name} / ${node.provider ?? copy.staticNodes})`));
    });
    if (!present.length) { deps.io.writeLine(unknown.length ? copy.nodesInspectionFailed : copy.allNodesMissing); valid = false; }
  }
  return valid;
}

export async function collectSelectedNodes(deps: CliWorkflowDependencies, draft: GeneratorSpec, targetId: string, copy: Copy): Promise<GeneratorSpec | null> {
  if (!supportsSelectedRouting(await deps.mihomoVersion?.() ?? null)) { deps.io.writeLine(copy.kernelUnsupported); return null; }
  const sourceId = draft.routing?.sources.find(source => source.kind === "target")?.id ?? "target";
  const sources = structuredClone(draft.routing?.sources ?? [{ id: sourceId, kind: "target" as const }]);
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]!;
    if (source.kind !== "subscription") continue;
    const profile = await deps.profiles.findBySource(source.source);
    const refreshed = profile ? await deps.profiles.describeRoutingSource?.(profile.profileId, source.id) : null;
    if (refreshed) sources[index] = refreshed;
  }
  const inspectedDraft = { ...draft, routing: { ...draft.routing!, sources } };
  const inspection = await inspectSources(deps, inspectedDraft, targetId);
  if (inspection.unknown.length) deps.io.writeLine(copy.nodesInspectionFailed);
  const current = draft.routing?.outlets[0];
  const chosen = new Map<string, RoutingNodeReference>((current?.kind === "selected" ? current.nodes : []).map(node => [identity(node), node]));
  const available = inspection.available;
  const candidates = [...available, ...[...chosen.values()].filter(node => !available.some(item => identity(item) === identity(node)))];
  let page = 0;
  let filter = "";
  nodeMenu: while (true) {
    const filtered = candidates.filter(node => node.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
    const pages = Math.max(1, Math.ceil(filtered.length / 10));
    page = Math.min(page, pages - 1);
    const displayed = filtered.slice(page * 10, (page + 1) * 10);
    const actions = [...displayed.map(node => ({ kind: "node" as const, node })),
      ...(page > 0 ? [{ kind: "previous" as const }] : []), ...(page + 1 < pages ? [{ kind: "next" as const }] : []),
      { kind: "filter" as const }, ...(deps.profiles.describeRoutingSource ? [{ kind: "source" as const }] : []), { kind: "done" as const }];
    const action = actions[await deps.io.choose(copy.nodesMenu(page + 1, pages, chosen.size), actions.map(action => {
      if (action.kind === "node") {
        const source = sources.find(item => item.id === action.node.sourceId)!;
        return `${chosen.has(identity(action.node)) ? "[x]" : "[ ]"} ${action.node.name} (${source.kind === "target" ? draft.targetProfile.name : source.name} / ${action.node.provider ?? copy.staticNodes})`;
      }
      return action.kind === "previous" ? copy.previousPage : action.kind === "next" ? copy.nextPage : action.kind === "filter" ? copy.filterParentGroups : action.kind === "source" ? copy.addNodeSource : copy.nodesDone;
    }))]!;
    if (action.kind === "previous") page--;
    else if (action.kind === "next") page++;
    else if (action.kind === "filter") {
      try { filter = await deps.io.ask(copy.nodeFilter); page = 0; }
      catch (error) { if (!(error instanceof BackRequestedError)) throw error; }
    }
    else if (action.kind === "source") {
      const catalog = (await deps.profiles.list()).filter(profile => profile.id !== targetId);
      if (!catalog.length || sources.length >= 65) { deps.io.writeLine(copy.nodesInspectionFailed); continue; }
      let selected;
      try { selected = catalog[await deps.io.choose(copy.selectNodeSource, catalog.map(profile => profile.name))]!; }
      catch (error) { if (error instanceof BackRequestedError) continue; throw error; }
      const profile = await deps.profiles.select(selected.id);
      if (!profile || sources.some(source => source.kind === "subscription" && source.source === profile.source)) { deps.io.writeLine(copy.duplicateSource); continue; }
      const source = await deps.profiles.describeRoutingSource?.(selected.id, deps.createChildId());
      const inspected = await deps.profiles.inspectRoutingNodes?.(selected.id);
      if (!source || !inspected || inspected.status === "failed") { deps.io.writeLine(copy.nodesInspectionFailed); continue; }
      sources.push(source);
      const added = inspected.nodes.filter(node => node.provider === null || source.providers?.some(provider => provider.id === node.provider))
        .map(node => ({ sourceId: source.id, provider: node.provider, name: node.name }));
      if (added.length !== inspected.nodes.length || inspected.failures.length) deps.io.writeLine(copy.nodesInspectionFailed);
      available.push(...added); candidates.push(...added); filter = ""; page = Math.floor((candidates.length - added.length) / 10);
    }
    else if (action.kind === "node") {
      const key = identity(action.node);
      if (chosen.has(key)) chosen.delete(key);
      else if (available.some(node => identity(node) === key)) chosen.set(key, action.node);
    } else {
      if (!chosen.size) { deps.io.writeLine(copy.nodesRequired); continue; }
      let name = current?.kind === "selected" ? current.groupName : "Kit AI";
      while (true) {
        let entered: string;
        try { entered = (await deps.io.ask(copy.outletName(name))).trim() || name; }
        catch (error) { if (error instanceof BackRequestedError) continue nodeMenu; throw error; }
        const target = await deps.profiles.select(targetId);
        if (!routingGroupName(entered) || !target || target.inspection.selectGroups.includes(entered)
          || draft.children.some(child => child.groupName === entered)) { deps.io.writeLine(copy.invalidName); continue; }
        name = entered;
        try { if (!await deps.io.confirm(copy.selectedConsent(name, chosen.size))) return null; break; }
        catch (error) { if (error instanceof BackRequestedError) continue; throw error; }
      }
      const next = editRoutingPlan(draft, {
        kind: "select-nodes", groupName: name, sources, nodes: [...chosen.values()],
      });
      return await verifySelectedNodes(deps, next, targetId, copy) ? next : null;
    }
  }
}
