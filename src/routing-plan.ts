import type { RoutingPlan } from "./types";

export const ROUTING_REVISION = "routing-v2";
export const LEGACY_ROUTING_REVISION = "routing-v1";
export type RoutingRevision = typeof ROUTING_REVISION | typeof LEGACY_ROUTING_REVISION;
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

export function exactKeys(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).every(key => allowed.includes(key));
}

export function routingName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value === value.trim() && !UNSAFE_NAME.test(value);
}

export function routingGroupName(value: unknown): value is string {
  return routingName(value) && !value.includes(",")
    && !["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"].includes(value);
}

function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function sourceLocation(mode: unknown, source: unknown): source is string {
  if (typeof source !== "string" || source.length > 4096) return false;
  if (mode === "file") return /^\.\/[A-Za-z0-9_./-]+\.ya?ml$/i.test(source) && !source.includes("..") && !source.includes("//");
  if (mode !== "http") return false;
  try { const url = new URL(source); return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname); } catch { return false; }
}

function domainSuffixes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 256 && value.every(domain => typeof domain === "string" && domain.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain));
}

export function normalizeRoutingPlan(value: unknown): RoutingPlan | null {
  if (!exactKeys(value, ["sources", "outlets", "modules", "legacyAi"])) return null;
  if (![value.sources, value.outlets, value.modules].every(array => Array.isArray(array) && array.length <= 65)) return null;
  const sources: RoutingPlan["sources"] = [];
  const outlets: RoutingPlan["outlets"] = [];
  const modules: RoutingPlan["modules"] = [];
  for (const source of value.sources as unknown[]) {
    if (!exactKeys(source, ["id", "kind", "name", "mode", "source", "providers"]) || !id(source.id)
      || sources.some(item => item.id === source.id)) return null;
    if (source.kind === "target") {
      if (!exactKeys(source, ["id", "kind"]) || sources.some(item => item.kind === "target")) return null;
      sources.push({ id: source.id, kind: source.kind });
    } else {
      if (source.kind !== "subscription" || !routingName(source.name) || !sourceLocation(source.mode, source.source)
        || sources.some(item => item.kind === "subscription" && item.mode === source.mode && item.source === source.source)) return null;
      const providers: NonNullable<import("./types").RoutingSubscriptionSource["providers"]> = [];
      if (source.providers !== undefined) {
        if (!Array.isArray(source.providers) || source.providers.length > 64) return null;
        for (const provider of source.providers) {
          if (!exactKeys(provider, ["id", "mode", "source", "interval"]) || !routingName(provider.id)
            || !sourceLocation(provider.mode, provider.source) || !Number.isInteger(provider.interval)
            || Number(provider.interval) < 0 || Number(provider.interval) > 86400 * 30
            || providers.some(item => item.id === provider.id)) return null;
          providers.push({ id: provider.id, mode: provider.mode as "http" | "file", source: provider.source, interval: Number(provider.interval) });
        }
      }
      sources.push({ id: source.id, kind: source.kind, name: source.name, mode: source.mode as "http" | "file", source: source.source,
        ...(source.providers !== undefined ? { providers } : {}) });
    }
  }
  for (const outlet of value.outlets as unknown[]) {
    if (!exactKeys(outlet, ["id", "kind", "groupName", "nodes"]) || !id(outlet.id) || !["existing", "selected"].includes(String(outlet.kind))
      || !routingGroupName(outlet.groupName)
      || outlets.some(item => item.id === outlet.id || item.groupName === outlet.groupName)) return null;
    if (outlet.kind === "existing") {
      if (outlet.nodes !== undefined) return null;
      outlets.push({ id: outlet.id, kind: outlet.kind, groupName: outlet.groupName });
    } else {
      if (!Array.isArray(outlet.nodes) || !outlet.nodes.length || outlet.nodes.length > 2048) return null;
      const nodes: import("./types").RoutingNodeReference[] = [];
      for (const node of outlet.nodes) {
        if (!exactKeys(node, ["sourceId", "provider", "name"]) || !id(node.sourceId)
          || !sources.some(source => source.id === node.sourceId)
          || (node.provider !== null && !routingName(node.provider)) || !routingName(node.name)
          || ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"].includes(node.name)
          || nodes.some(item => item.sourceId === node.sourceId && item.provider === node.provider && item.name === node.name)) return null;
        const source = sources.find(item => item.id === node.sourceId)!;
        if (source.kind === "subscription" && node.provider !== null && !source.providers?.some(provider => provider.id === node.provider)) return null;
        nodes.push({ sourceId: node.sourceId, provider: node.provider, name: node.name });
      }
      outlets.push({ id: outlet.id, kind: "selected", groupName: outlet.groupName, nodes });
    }
  }
  for (const module of value.modules as unknown[]) {
    if (!exactKeys(module, ["id", "kind", "enabled", "outletId", "ruleSource", "customDomains"])
      || !id(module.id) || module.kind !== "ai" || typeof module.enabled !== "boolean"
      || !id(module.outletId) || !outlets.some(item => item.id === module.outletId)
      || !["category-ai-v1", "services-v1", "legacy-ai-v1"].includes(String(module.ruleSource))
      || modules.some(item => item.id === module.id)
      || !domainSuffixes(module.customDomains)) return null;
    modules.push({ id: module.id, kind: module.kind, enabled: module.enabled, outletId: module.outletId,
      ruleSource: module.ruleSource as RoutingPlan["modules"][number]["ruleSource"], customDomains: [...module.customDomains] });
  }
  let legacyAi: RoutingPlan["legacyAi"];
  if (value.legacyAi !== undefined) {
    const legacy = value.legacyAi;
    if (!exactKeys(legacy, ["ruleSource", "groupName", "customDomains"])
      || !["services-v1", "legacy-ai-v1"].includes(String(legacy.ruleSource))
      || !routingGroupName(legacy.groupName) || !domainSuffixes(legacy.customDomains)) return null;
    legacyAi = { ruleSource: legacy.ruleSource as "services-v1" | "legacy-ai-v1", groupName: legacy.groupName, customDomains: [...legacy.customDomains] };
  }
  return { sources, outlets, modules, ...(legacyAi ? { legacyAi } : {}) };
}
