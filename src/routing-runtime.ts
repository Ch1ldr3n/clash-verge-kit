import type { RoutingPlan } from "./types";
import { sha256Hex } from "./integrity.ts";

// Match only the fixed providers/rules emitted by the authenticated V1/V2 plan.
function legacyRemoval(plan: RoutingPlan) {
  const legacy = plan.legacyAi;
  if (!legacy) return null;
  const names = legacy.ruleSource === "services-v1" ? ["openai", "anthropic", "google-deepmind"] : ["category-ai-!cn"];
  let hash = 0x811c9dc5;
  for (const character of `ai:${legacy.groupName}`.split("")) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  const entries = names.map(name => {
    const format = legacy.ruleSource === "services-v1" ? "text" : "mrs";
    const extension = format === "text" ? "list" : "mrs";
    return { collection: "rule-providers", name: "clash_verge_kit_ai_" + (format === "text" ? name.replace(/-/g, "_") : (hash >>> 0).toString(16).padStart(8, "0")),
      value: JSON.stringify({ type: "http", behavior: "domain", format,
        url: `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/${name}.${extension}`,
        path: `./rule_provider/clash-verge-kit/${name}.${extension}`, interval: 86400 }) };
  });
  return { rules: [...legacy.customDomains.map(domain => `DOMAIN-SUFFIX,${domain},${legacy.groupName}`),
    ...entries.map(entry => `RULE-SET,${entry.name},${legacy.groupName}`)], objects: entries };
}

// A revision's template is part of the saved-script format. Preserve its bytes
// when introducing a later revision so full-script authentication stays valid.
export function buildRoutingRuntime(plan: RoutingPlan, target: string, prelude: string, hasNesting: boolean): string {
  const identities = new Map<string, string>();
  for (const outlet of plan.outlets) if (outlet.kind === "selected") {
    for (const node of outlet.nodes) if (node.provider !== null || plan.sources.find(source => source.id === node.sourceId)?.kind === "subscription") {
      const identity = JSON.stringify([node.sourceId, node.provider]);
      identities.set(identity, sha256Hex(identity).slice(0, 24));
    }
  }
  const settings = JSON.stringify({ target, plan, aliases: Object.fromEntries(identities), legacy: legacyRemoval(plan) }, null, 2).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `${prelude}
/* Routing V1; no file or network I/O. */
const ROUTING = ${settings};
function main(config, profileName) {
  if (profileName !== ROUTING.target) return config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid routing configuration / 分流配置无效。");
  const output = JSON.parse(JSON.stringify(config));
  const stateKey = "clash-verge-kit-routing";
  let previous = output[stateKey];
  if (previous === undefined && ROUTING.legacy) {
    const legacy = ROUTING.legacy;
    const rules = Array.isArray(output.rules) ? output.rules : [];
    const providers = output["rule-providers"] || {};
    if (legacy.objects.some(function (entry) { return Object.prototype.hasOwnProperty.call(providers, entry.name); })
      || legacy.rules.some(function (rule) { return rule.startsWith("RULE-SET,") && rules.indexOf(rule) >= 0; })) {
      previous = { schema: "clash-verge-kit/runtime-routing-v1", target: ROUTING.target, rules: legacy.rules, objects: legacy.objects };
    }
  }
  const owned = [];
  const filters = [];
  if (previous !== undefined) {
    if (!previous || previous.schema !== "clash-verge-kit/runtime-routing-v1" || previous.target !== ROUTING.target
      || !Array.isArray(previous.rules) || !Array.isArray(previous.objects)) throw new Error("Unknown ownership / 分流对象归属不明。");
    if (previous.filters !== undefined && !Array.isArray(previous.filters)) throw new Error("Unknown ownership / 分流对象归属不明。");
    (previous.filters || []).forEach(function (entry) {
      const matches = (output["proxy-groups"] || []).filter(function (group) { return group.name === entry.name; });
      if (matches.length !== 1 || typeof matches[0]["exclude-filter"] !== "string" || typeof entry.added !== "string") {
        throw new Error("Changed isolation filter / 节点隔离条件已被修改。");
      }
      const parts = matches[0]["exclude-filter"].split("\x60");
      const index = parts.indexOf(entry.added);
      if (index < 0) throw new Error("Changed isolation filter / 节点隔离条件已被修改。");
      parts.splice(index, 1);
      if (parts.length || !entry.wasAbsent) matches[0]["exclude-filter"] = parts.join("\x60");
      else delete matches[0]["exclude-filter"];
    });
    const oldRules = Array.isArray(output.rules) ? output.rules.slice() : [];
    previous.rules.forEach(function (rule) {
      const index = oldRules.indexOf(rule);
      if (index < 0) throw new Error("Changed routing rule / 分流规则已被修改。");
      oldRules.splice(index, 1);
    });
    output.rules = oldRules;
    delete output[stateKey];
    const candidates = previous.objects.map(function (entry) {
      if (!entry || ["rule-providers", "proxy-providers", "proxy-groups"].indexOf(entry.collection) < 0
        || typeof entry.name !== "string" || typeof entry.value !== "string") throw new Error("Unknown ownership / 分流对象归属不明。");
      const container = output[entry.collection];
      const values = Array.isArray(container) ? container.filter(function (item) { return item.name === entry.name; }) : [container && container[entry.name]];
      if (values.length !== 1 || JSON.stringify(values[0]) !== entry.value) throw new Error("Changed routing object / 分流对象已被修改。");
      return { entry: entry, value: values[0], keep: false };
    });
    function strings(value, result) {
      if (typeof value === "string") { result.add(value); value.split(",").forEach(function (part) { result.add(part); }); }
      else if (Array.isArray(value)) value.forEach(function (item) { strings(item, result); });
      else if (value && typeof value === "object") Object.keys(value).forEach(function (key) { if (key !== "name") strings(value[key], result); });
    }
    const references = new Set();
    Object.keys(output).forEach(function (key) {
      const collection = output[key];
      if (["rule-providers", "proxy-providers", "proxy-groups", "proxies"].indexOf(key) < 0) strings(collection, references);
      else if (Array.isArray(collection)) collection.forEach(function (value) {
        if (!candidates.some(function (candidate) { return candidate.value === value; })) strings(value, references);
      });
      else if (collection) Object.keys(collection).forEach(function (name) {
        if (!candidates.some(function (candidate) { return candidate.value === collection[name]; })) strings(collection[name], references);
      });
    });
    let changed = true;
    while (changed) {
      changed = false;
      candidates.forEach(function (candidate) {
        if (!candidate.keep && references.has(candidate.entry.name)) {
          candidate.keep = true; changed = true; strings(candidate.value, references);
        }
      });
    }
    candidates.filter(function (candidate) { return !candidate.keep; }).forEach(function (candidate) {
      const entry = candidate.entry;
      const container = output[entry.collection];
      if (Array.isArray(container)) output[entry.collection] = container.filter(function (value) { return value !== candidate.value; });
      else { delete container[entry.name]; if (!Object.keys(container).length) delete output[entry.collection]; }
    });
    candidates.filter(function (candidate) { return candidate.keep; }).forEach(function (candidate) { owned.push(candidate.entry); });
  }
  ${hasNesting ? "applyNesting(output, profileName);" : ""}
  const groups = Array.isArray(output["proxy-groups"]) ? output["proxy-groups"] : [];
  const nodes = Array.isArray(output.proxies) ? output.proxies : [];
  const nodeProviders = output["proxy-providers"] || {};
  const rules = Array.isArray(output.rules) ? output.rules : [];
  const providers = output["rule-providers"] || {};
  const additions = [];
  const active = new Set();
  const checked = new Set();
  function escapeName(name) {
    return Array.from(name).map(function (character) {
      const code = character.charCodeAt(0);
      return code < 128 ? "\\\\x" + code.toString(16).padStart(2, "0") : character;
    }).join("");
  }
  ROUTING.plan.outlets.filter(function (outlet) {
    return outlet.kind === "selected" && ROUTING.plan.modules.some(function (module) { return module.enabled && module.outletId === outlet.id; });
  }).forEach(function (outlet) {
    if (nodes.some(function (node) { return node.name === outlet.groupName; })) {
      throw new Error("Outlet name conflict / 出口组名称冲突。");
    }
    const use = [];
    const names = outlet.nodes.map(function (node) {
      const source = ROUTING.plan.sources.find(function (item) { return item.id === node.sourceId; });
      if (node.provider === null && source.kind === "target") return node.name;
      const location = source.kind === "subscription" ? (node.provider === null ? source : source.providers.find(function (item) { return item.id === node.provider; })) : null;
      const original = location ? (location.mode === "http"
        ? { type: "http", url: location.source, interval: location.interval || 3600, "health-check": { enable: false } }
        : { type: "file", path: location.source, "health-check": { enable: false } }) : nodeProviders[node.provider];
      if (!original) return null;
      if (original.override && original.override["override-expr"]) throw new Error("Unsupported node transformation / 不支持该节点变换。");
      const hash = ROUTING.aliases[JSON.stringify([node.sourceId, node.provider])];
      const key = "clash_verge_kit_nodes_" + hash;
      const prefix = "[Kit:" + hash + "] ";
      if (nodes.some(function (item) { return item.name.startsWith(prefix); })) throw new Error("Node alias conflict / 节点别名冲突。");
      const copy = JSON.parse(JSON.stringify(original));
      delete copy.filter; delete copy["exclude-filter"]; delete copy["exclude-type"];
      copy.override = Object.assign({}, copy.override, { "additional-prefix": prefix });
      delete copy.override["additional-suffix"]; delete copy.override["proxy-name"];
      if (copy.type === "http") copy.path = "./proxy_provider/clash-verge-kit/" + key + ".yaml";
      if (Object.prototype.hasOwnProperty.call(nodeProviders, key) && JSON.stringify(nodeProviders[key]) !== JSON.stringify(copy)) {
        throw new Error("Provider alias conflict / 节点来源别名冲突。");
      }
      if (!Object.prototype.hasOwnProperty.call(nodeProviders, key)) owned.push({ collection: "proxy-providers", name: key, value: JSON.stringify(copy) });
      nodeProviders[key] = copy;
      if (use.indexOf(key) < 0) use.push(key);
      return prefix + node.name;
    }).filter(function (name) { return name !== null; });
    names.forEach(function (name) {
      if (nodes.filter(function (node) { return node.name === name; }).length > 1) throw new Error("Ambiguous node / 节点名称重复。");
    });
    const group = { name: outlet.groupName, type: "select", "include-all-proxies": true,
      filter: names.length ? "^(" + names.map(escapeName).join("|") + ")$" : "a^", "empty-fallback": "REJECT",
      ...(use.length ? { use: use } : {}) };
    const existing = groups.filter(function (item) { return item.name === group.name; });
    if (existing.length) {
      if (existing.length !== 1 || !owned.some(function (entry) {
        return entry.collection === "proxy-groups" && entry.name === group.name && entry.value === JSON.stringify(group);
      })) throw new Error("Outlet name conflict / 出口组名称冲突。");
    } else {
      groups.push(group);
      owned.push({ collection: "proxy-groups", name: group.name, value: JSON.stringify(group) });
    }
    output["proxy-groups"] = groups;
    if (use.length) output["proxy-providers"] = nodeProviders;
  });
  // Mihomo include-all groups collect every provider. Exclude only our private
  // aliases, preserving original candidates and explicitly shared provider use.
  const privateProviders = owned.filter(function (entry) { return entry.collection === "proxy-providers"; });
  groups.filter(function (group) { return group["include-all"] || group["include-all-providers"]; }).forEach(function (group) {
    const prefixes = privateProviders.filter(function (entry) { return !(group.use || []).includes(entry.name); })
      .map(function (entry) { return nodeProviders[entry.name].override["additional-prefix"]; });
    if (!prefixes.length) return;
    const added = "^(" + prefixes.map(escapeName).join("|") + ")";
    const wasAbsent = group["exclude-filter"] === undefined;
    const parts = typeof group["exclude-filter"] === "string" && group["exclude-filter"] ? group["exclude-filter"].split("\x60") : [];
    if (!parts.includes(added)) {
      parts.push(added); group["exclude-filter"] = parts.join("\x60");
      filters.push({ name: group.name, added: added, wasAbsent: wasAbsent });
    }
  });
  function checkGroup(group) {
    if (active.has(group.name)) throw new Error("Cyclic outlet / 出口存在循环引用。");
    if (checked.has(group.name)) return;
    active.add(group.name);
    (group.use || []).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(nodeProviders, key)) throw new Error("Missing provider / 节点来源不存在。");
    });
    (group.proxies || []).forEach(function (name) {
      if (["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"].indexOf(name) >= 0) return;
      const matches = groups.filter(function (item) { return item && item.name === name; });
      const matchingNodes = nodes.filter(function (item) { return item && item.name === name; });
      if (matches.length + matchingNodes.length !== 1) throw new Error("Missing or ambiguous outlet member / 出口成员不存在或重名。");
      if (matches.length) checkGroup(matches[0]);
    });
    active.delete(group.name);
    checked.add(group.name);
  }
  ROUTING.plan.modules.filter(function (module) { return module.enabled; }).forEach(function (module) {
    const outlet = ROUTING.plan.outlets.find(function (item) { return item.id === module.outletId; });
    const matches = groups.filter(function (group) { return group && group.name === outlet.groupName; });
    if (matches.length !== 1 || matches[0].type !== "select") throw new Error("Invalid outlet / 出口组不存在或不受支持。");
    checkGroup(matches[0]);
    const names = module.ruleSource === "services-v1" ? ["openai", "anthropic", "google-deepmind"] : ["category-ai-!cn"];
    module.customDomains.forEach(function (domain) { additions.push("DOMAIN-SUFFIX," + domain + "," + outlet.groupName); });
    names.forEach(function (name) {
      const key = "clash_verge_kit_routing_" + module.id + "_" + name.replace(/[^A-Za-z0-9]/g, "_");
      const format = module.ruleSource === "legacy-ai-v1" ? "mrs" : "text";
      const extension = format === "mrs" ? "mrs" : "list";
      const value = { type: "http", behavior: "domain", format: format,
        url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/" + name + "." + extension,
        path: "./rule_provider/clash-verge-kit/" + key + "." + extension, interval: 86400 };
      if (Object.prototype.hasOwnProperty.call(providers, key) && JSON.stringify(providers[key]) !== JSON.stringify(value)) {
        throw new Error("Routing name conflict / 分流对象名称冲突。");
      }
      if (!Object.prototype.hasOwnProperty.call(providers, key)) owned.push({ collection: "rule-providers", name: key, value: JSON.stringify(value) });
      providers[key] = value;
      additions.push("RULE-SET," + key + "," + outlet.groupName);
    });
  });
  if (additions.length) {
    output["rule-providers"] = providers;
    output.rules = additions.concat(rules);
  }
  if (additions.length || owned.length || filters.length) {
    owned.sort(function (left, right) { return (left.collection + ":" + left.name).localeCompare(right.collection + ":" + right.name); });
    output[stateKey] = { schema: "clash-verge-kit/runtime-routing-v1", target: ROUTING.target, rules: additions, objects: owned, filters: filters };
  }
  return output;
}`;
}
