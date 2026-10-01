import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { routingName } from "../src/routing-plan.ts";

export interface RoutingNodeInspection {
  status: "available" | "partial" | "failed";
  nodes: { provider: string | null; name: string }[];
  failures: { provider: string | null; reason: "unreadable" | "unsupported" | "ambiguous" }[];
}

export async function readBoundedYaml(file: string, directory: string): Promise<Record<string, unknown>> {
  const [fileStat, resolved, base] = await Promise.all([lstat(file), realpath(file), realpath(directory)]);
  const relative = path.relative(base, resolved);
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > 5 * 1024 * 1024
    || !relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("unsafe-snapshot");
  const root: unknown = parse(await readFile(file, "utf8"));
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("invalid-snapshot");
  return root as Record<string, unknown>;
}

export async function inspectLocalRoutingNodes(root: Record<string, unknown>, directory: string): Promise<RoutingNodeInspection> {
  const nodes: RoutingNodeInspection["nodes"] = [];
  const failures: RoutingNodeInspection["failures"] = [];
  function collect(value: unknown, provider: string | null) {
    if (!Array.isArray(value)) { failures.push({ provider, reason: "unsupported" }); return; }
    const names = value.map(node => node && typeof node === "object" ? node.name as unknown : null);
    if (names.some(name => !routingName(name)) || new Set(names).size !== names.length || names.length > 20000) {
      failures.push({ provider, reason: "ambiguous" }); return;
    }
    nodes.push(...(names as string[]).filter(name => !["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"].includes(name))
      .map(name => ({ provider, name })));
  }
  try {
    if (!Array.isArray(root.proxies) && (!root["proxy-providers"] || typeof root["proxy-providers"] !== "object")) throw new Error("unsupported-snapshot");
    collect(root.proxies ?? [], null);
    const providers = root["proxy-providers"] ?? {};
    if (typeof providers !== "object" || Array.isArray(providers)) throw new Error("unsupported-providers");
    for (const [key, value] of Object.entries(providers)) {
      if (!routingName(key) || !value || typeof value !== "object" || Array.isArray(value)) { failures.push({ provider: null, reason: "unsupported" }); continue; }
      const provider = value as Record<string, any>;
      if (provider.override?.["override-expr"]) { failures.push({ provider: key, reason: "unsupported" }); continue; }
      if (Array.isArray(provider.payload)) { collect(provider.payload, key); continue; }
      if (typeof provider.path !== "string") { failures.push({ provider: key, reason: "unreadable" }); continue; }
      try {
        const data = await readBoundedYaml(path.resolve(directory, provider.path), directory);
        collect(data.proxies, key);
      } catch { failures.push({ provider: key, reason: "unreadable" }); }
    }
    return { status: failures.length ? "partial" : "available", nodes, failures };
  } catch {
    return { status: "failed", nodes: [], failures: [{ provider: null, reason: "unreadable" }] };
  }
}
