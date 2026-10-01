import type { GeneratorSpec, RoutingNodeReference } from "../src/types.ts";
import { normalizeRoutingPlan, routingGroupName } from "../src/routing-plan.ts";
import { BackRequestedError } from "./cli-io.ts";
import type { CliWorkflowDependencies } from "./cli-workflow.ts";
import { getCliMessages } from "./cli-messages.ts";
import { editRoutingPlan } from "../src/routing-plan-editing.ts";
import { supportsSelectedRouting } from "./mihomo-capability.ts";
import { inspectNewRoutingSource, inspectRoutingSources } from "./routing-source-catalog.ts";

type Copy = ReturnType<typeof getCliMessages>;
const identity = (node: RoutingNodeReference) => JSON.stringify([node.sourceId, node.provider, node.name]);

export async function verifySelectedNodes(deps: CliWorkflowDependencies, draft: GeneratorSpec, targetId: string, copy: Copy): Promise<boolean> {
  const selected = draft.routing?.outlets.filter(outlet => outlet.kind === "selected"
    && draft.routing!.modules.some(module => module.enabled && module.outletId === outlet.id)) ?? [];
  if (!selected.length) return true;
  if (!supportsSelectedRouting(await deps.mihomoVersion?.() ?? null)) { deps.io.writeLine(copy.kernelUnsupported); return false; }
  const inspection = await inspectRoutingSources(deps.profiles, draft, targetId, "delivery");
  if (!inspection.targetVerified) { deps.io.writeLine(copy.aiUnavailable); return false; }
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
  const inspection = await inspectRoutingSources(deps.profiles, draft, targetId, "selection");
  const sources = inspection.sources;
  if (inspection.unknown.length) deps.io.writeLine(copy.nodesInspectionFailed);
  const current = draft.routing?.outlets[0];
  const chosen = new Map<string, RoutingNodeReference>((current?.kind === "selected" ? current.nodes : []).map(node => [identity(node), node]));
  const available = inspection.available;
  const availableKeys = new Set(available.map(identity));
  const candidates = [...available, ...[...chosen.values()].filter(node => !availableKeys.has(identity(node)))];
  let page = 0;
  let filter = "";
  nodeMenu: while (true) {
    const filtered = candidates.filter(node => node.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
    const pages = Math.max(1, Math.ceil(filtered.length / 10));
    page = Math.min(page, pages - 1);
    const displayed = filtered.slice(page * 10, (page + 1) * 10);
    const actions = [...displayed.map(node => ({ kind: "node" as const, node })),
      ...(page > 0 ? [{ kind: "previous" as const }] : []), ...(page + 1 < pages ? [{ kind: "next" as const }] : []),
      { kind: "filter" as const }, ...(deps.profiles.readRoutingSnapshot ? [{ kind: "source" as const }] : []), { kind: "done" as const }];
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
      const added = await inspectNewRoutingSource(deps.profiles, selected.id, deps.createChildId());
      if (!added) { deps.io.writeLine(copy.nodesInspectionFailed); continue; }
      if (added.source.source === draft.targetProfile.source || sources.some(source => source.kind === "subscription"
        && source.source === added.source.source)) { deps.io.writeLine(copy.duplicateSource); continue; }
      sources.push(added.source);
      if (added.partial) deps.io.writeLine(copy.nodesInspectionFailed);
      for (const node of added.nodes) availableKeys.add(identity(node));
      candidates.push(...added.nodes); filter = ""; page = Math.floor((candidates.length - added.nodes.length) / 10);
    }
    else if (action.kind === "node") {
      const key = identity(action.node);
      if (chosen.has(key)) chosen.delete(key);
      else if (availableKeys.has(key)) chosen.set(key, action.node);
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
      if (!normalizeRoutingPlan(next.routing)) { deps.io.writeLine(copy.nodeSourceChanged); return null; }
      return await verifySelectedNodes(deps, next, targetId, copy) ? next : null;
    }
  }
}
