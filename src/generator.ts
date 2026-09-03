import type {
  Diagnostic,
  GenerationResult,
  GeneratorSpec,
  ProviderMode,
  RemovedChildSubscription,
  TopologySummary,
} from "./types";
import {
  createManagementMetadataBlock,
  MAX_MANAGED_CHILDREN,
  redactManagedSpec,
} from "./script-import.ts";

const AI_RULESET_URL =
  "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/category-ai-!cn.mrs";
const GROUP_NAME_FORBIDDEN = /[,\r\n]/;
const SAFE_FILE_PROVIDER = /^\.\/profiles\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/i;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface RuntimeChild {
  providerKey: string;
  legacyProviderKey: string;
  groupName: string;
  nodePrefix: string;
  provider: Record<string, unknown>;
}

interface RuntimeRemovedChild extends RemovedChildSubscription {}

interface RuntimeSettings {
  targetProfileName: string;
  parentGroupMode: "auto" | "manual";
  parentGroupName: string;
  children: RuntimeChild[];
  removedChildren: RuntimeRemovedChild[];
  ai: {
    enabled: boolean;
    mode: "existing" | "create";
    groupName: string;
    customDomains: string[];
    providerKey: string;
    provider: Record<string, unknown>;
  };
}

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  zh: string,
  en: string,
  field?: string,
): Diagnostic {
  return { code, severity, message: { zh, en }, field };
}

export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function deriveNodePrefix(groupName: string): string {
  return `[${groupName.trim()}] `;
}

export function createRemovedChildSubscription(child: {
  groupName: string;
  mode: ProviderMode;
  source: string;
  nodePrefix?: string;
}): RemovedChildSubscription {
  const groupName = child.groupName.trim();
  return {
    groupName,
    nodePrefix: child.nodePrefix?.trim() || deriveNodePrefix(groupName),
    providerKey: groupName,
    legacyProviderKey: `clash_verge_kit_${stableHash(`provider:${groupName}`)}`,
    providerMode: child.mode,
    sourceHash: stableHash(`source:${child.mode}:${child.source.trim()}`),
  };
}

export function maskSubscriptionUrl(value: string): string {
  const protocol = /^https?:\/\//i.exec(value.trim())?.[0]?.toLowerCase() ?? "https://";
  return `${protocol}••••••••••••`;
}

export function isSafeFileProviderPath(value: string): boolean {
  const trimmed = value.trim();
  return SAFE_FILE_PROVIDER.test(trimmed) && !trimmed.includes("..") && !trimmed.includes("\\");
}

export function safeProfilePath(fileName: string): string | null {
  const baseName = fileName.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/i.test(baseName) || baseName.includes("..")) {
    return null;
  }
  return `./profiles/${baseName}`;
}

export function normalizeDomainSuffix(value: string): string | null {
  let candidate = value.trim().toLowerCase();
  candidate = candidate.replace(/^(?:\*\.|\+\.)/, "").replace(/^\.+|\.+$/g, "");
  if (
    !candidate ||
    candidate.includes("://") ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    candidate.includes(" ") ||
    candidate.includes("..") ||
    /^\d+(?:\.\d+){3}$/.test(candidate) ||
    candidate.startsWith("[")
  ) {
    return null;
  }

  let ascii = candidate;
  try {
    ascii = new URL(`http://${candidate}`).hostname.toLowerCase();
  } catch {
    return null;
  }

  const labels = ascii.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    return null;
  }
  return ascii;
}

function validateGroupName(
  value: string,
  field: string,
  diagnostics: Diagnostic[],
  labelZh: string,
  labelEn: string,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    diagnostics.push(
      diagnostic("group-name-required", "error", `${labelZh}不能为空。`, `${labelEn} is required.`, field),
    );
  } else if (GROUP_NAME_FORBIDDEN.test(trimmed)) {
    diagnostics.push(
      diagnostic(
        "group-name-forbidden-character",
        "error",
        `${labelZh}不能包含逗号或换行。`,
        `${labelEn} cannot contain commas or line breaks.`,
        field,
      ),
    );
  }
  return trimmed;
}

function validateHttpSource(source: string): boolean {
  try {
    const parsed = new URL(source.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeSourceIdentity(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.searchParams.sort();
    return `url:${parsed.toString()}`;
  } catch {
    if (!isSafeFileProviderPath(trimmed)) {
      return null;
    }
    return `file:${trimmed.replace(/\\/g, "/").toLowerCase()}`;
  }
}

function createProvider(mode: ProviderMode, source: string, providerKey: string) {
  const common = {
    "health-check": {
      enable: true,
      url: "https://www.gstatic.com/generate_204",
      interval: 600,
      timeout: 5000,
      lazy: true,
    },
  };

  if (mode === "file") {
    return {
      type: "file",
      path: source,
      ...common,
    };
  }

  return {
    type: "http",
    url: source,
    path: `./proxy_providers/clash-verge-kit/${providerKey}.yaml`,
    interval: 21600,
    ...common,
  };
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function formatReadableRuntimeScript(script: string): string {
  const lines = script.replace(/\n{3,}/g, "\n\n").trim().split("\n");
  return lines.filter((line, index) => {
    if (line.trim()) return true;
    const next = lines[index + 1] ?? "";
    return /^function /.test(next)
      || next.startsWith("/* Generated")
      || next.startsWith("const SETTINGS");
  }).join("\n");
}

function buildRuntimeScript(settings: RuntimeSettings, managementBlock: string): string {
  const runtimeSettings = settings.ai.enabled
    ? settings
    : {
        targetProfileName: settings.targetProfileName,
        parentGroupMode: settings.parentGroupMode,
        parentGroupName: settings.parentGroupName,
        children: settings.children,
        removedChildren: settings.removedChildren,
      };
  const resolveParentRuntime = settings.parentGroupMode === "manual"
    ? `function resolveParent(_config, groups) {
  const manual = findGroup(groups, SETTINGS.parentGroupName);
  if (!manual) {
    throw new Error("未找到主代理组：" + SETTINGS.parentGroupName);
  }
  if (manual.type !== "select") {
    throw new Error("主代理组必须是 select 类型：" + SETTINGS.parentGroupName);
  }
  return manual;
}`
    : `function autoParentCandidates(groups) {
  const excludedNames = new Set(
    SETTINGS.children.concat(SETTINGS.removedChildren).map(function (child) {
      return child.groupName;
    })
  );
  ${settings.ai.enabled ? "excludedNames.add(SETTINGS.ai.groupName);" : ""}
  return groups.filter(function (group) {
    return Boolean(
      group &&
      group.type === "select" &&
      typeof group.name === "string" &&
      group.name &&
      !excludedNames.has(group.name)
    );
  });
}

function terminalRuleTarget(rules) {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (typeof rule !== "string") {
      continue;
    }
    const parts = rule.split(",");
    const kind = (parts[0] || "").trim().toUpperCase();
    if (kind === "MATCH" || kind === "FINAL") {
      return (parts[1] || "").trim();
    }
  }
  return "";
}

function resolveParent(config, groups) {
  const candidates = autoParentCandidates(groups);
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const target = terminalRuleTarget(rules);
  if (target) {
    const matched = candidates.find(function (group) {
      return group.name === target;
    });
    if (matched) {
      return matched;
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }
  if (!candidates.length) {
    throw new Error("无法自动识别主代理组：未找到可用的 select 组。请改用手动指定。");
  }
  throw new Error(
    "无法自动识别主代理组，可选 select 组：" +
    candidates.map(function (group) { return group.name; }).join("、") +
    "。请改用手动指定。"
  );
}`;
  const runtime = `${managementBlock}
/* Generated by Clash Verge Kit; no file or network I/O. */

const SETTINGS = Object.freeze(${serializeForScript(runtimeSettings)});

function clonePlain(value) { return JSON.parse(JSON.stringify(value)); }

function findGroup(groups, name) {
  return groups.find(function (group) {
    return group && group.name === name;
  });
}

${resolveParentRuntime}

function escapeRegex(value) { return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"); }

/* REMOVE_ONLY_START */
function stableHashRuntime(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
/* REMOVE_ONLY_END */

function hasIncludeAll(group) {
  return Boolean(
    group["include-all"] ||
    group["include-all-proxies"] ||
    group["include-all-providers"]
  );
}

/* CHILD_ONLY_START */
function providerForParent(child, prefixRequired) {
  const provider = clonePlain(child.provider);
  if (prefixRequired) {
    provider.override = provider.override || {};
    provider.override["additional-prefix"] = child.nodePrefix;
  }
  return provider;
}
/* CHILD_ONLY_END */

function splitExcludeFilters(group) {
  return typeof group["exclude-filter"] === "string" && group["exclude-filter"]
    ? group["exclude-filter"].split("\x60")
    : [];
}

function appendExcludeFilter(group, filter) {
  const filters = splitExcludeFilters(group);
  if (!filters.includes(filter)) {
    filters.push(filter);
  }
  group["exclude-filter"] = filters.join("\x60");
}

/* CHILD_ONLY_START */
function providerMatches(existing, child) {
  if (!existing || existing.type !== child.provider.type) {
    return false;
  }
  const sourceKey = child.provider.type === "file" ? "path" : "url";
  const existingPrefix = existing.override && existing.override["additional-prefix"];
  return (
    existing[sourceKey] === child.provider[sourceKey] &&
    (existingPrefix === undefined || existingPrefix === child.nodePrefix)
  );
}
/* CHILD_ONLY_END */

function groupUsesProvider(group, providerKey) { return Boolean(group && Array.isArray(group.use) && group.use.includes(providerKey)); }

/* REMOVE_ONLY_START */
function removalProviderMatches(existing, child) {
  if (!existing || existing.type !== child.providerMode) {
    return false;
  }
  const sourceKey = child.providerMode === "file" ? "path" : "url";
  if (typeof existing[sourceKey] !== "string") {
    return false;
  }
  if (stableHashRuntime("source:" + child.providerMode + ":" + existing[sourceKey].trim()) !== child.sourceHash) {
    return false;
  }
  if (
    child.providerMode === "http" &&
    existing.path !== "./proxy_providers/clash-verge-kit/" + child.legacyProviderKey + ".yaml"
  ) {
    return false;
  }
  const existingPrefix = existing.override && existing.override["additional-prefix"];
  return existingPrefix === undefined || existingPrefix === child.nodePrefix;
}
/* REMOVE_ONLY_END */

/* AI_ONLY_START */
function aiProviderMatches(existing) {
  return Boolean(
    existing &&
    existing.type === SETTINGS.ai.provider.type &&
    existing.url === SETTINGS.ai.provider.url &&
    existing.format === "mrs" &&
    existing.behavior === "domain"
  );
}
/* AI_ONLY_END */

/* CHILD_ONLY_START */
function isManagedChildGroup(group, child) {
  return Boolean(
    group &&
    group.type === "select" &&
    Array.isArray(group.use) &&
    (group.use.includes(child.providerKey) || group.use.includes(child.legacyProviderKey))
  );
}
/* CHILD_ONLY_END */

/* AI_ONLY_START */
function aiRuleLine() {
  return "RULE-SET," + SETTINGS.ai.providerKey + "," + SETTINGS.ai.groupName;
}
/* AI_ONLY_END */

function preflight(config, groups, parent) {
  const providers = config["proxy-providers"] || {};
  /* REMOVE_ONLY_START */
  SETTINGS.removedChildren.forEach(function (child) {
    const existingGroup = findGroup(groups, child.groupName);
    const currentProvider = providers[child.providerKey];
    const legacyProvider = providers[child.legacyProviderKey];
    const presentProviders = [currentProvider, legacyProvider].filter(Boolean);

    if (!existingGroup && !presentProviders.length) {
      return;
    }
    if (!existingGroup || presentProviders.length !== 1) {
      throw new Error("无法确认待移除子订阅的所有权：" + child.groupName);
    }

    const activeProviderKey = currentProvider ? child.providerKey : child.legacyProviderKey;
    const activeProvider = currentProvider || legacyProvider;
    if (
      existingGroup.type !== "select" ||
      !Array.isArray(existingGroup.use) ||
      existingGroup.use.length !== 1 ||
      existingGroup.use[0] !== activeProviderKey
    ) {
      throw new Error("待移除子组已被修改，已停止：" + child.groupName);
    }
    if (!removalProviderMatches(activeProvider, child)) {
      throw new Error("待移除代理提供者来源不匹配，已停止：" + activeProviderKey);
    }

    const groupReference = groups.find(function (group) {
      return group !== parent && Array.isArray(group.proxies) && group.proxies.includes(child.groupName);
    });
    if (groupReference) {
      throw new Error("其他代理组仍引用待移除子组：" + groupReference.name + " → " + child.groupName);
    }
    const providerReference = groups.find(function (group) {
      return group !== existingGroup && groupUsesProvider(group, activeProviderKey);
    });
    if (providerReference) {
      throw new Error("其他代理组仍引用待移除代理提供者：" + providerReference.name + " → " + activeProviderKey);
    }
  });
  /* REMOVE_ONLY_END */

  /* CHILD_ONLY_START */
  SETTINGS.children.forEach(function (child) {
    const existingGroup = findGroup(groups, child.groupName);
    const currentProvider = providers[child.providerKey];
    const legacyProvider = providers[child.legacyProviderKey];
    if (currentProvider && (!groupUsesProvider(existingGroup, child.providerKey) || !providerMatches(currentProvider, child))) {
      throw new Error("代理提供者键冲突：" + child.providerKey);
    }
    if (existingGroup && !isManagedChildGroup(existingGroup, child)) {
      throw new Error("代理组名称冲突：" + child.groupName);
    }
    if (legacyProvider) {
      if (!groupUsesProvider(existingGroup, child.legacyProviderKey) || !providerMatches(legacyProvider, child)) {
        throw new Error("旧版代理提供者键冲突：" + child.legacyProviderKey);
      }
      const reusedElsewhere = groups.some(function (group) {
        return group !== existingGroup && groupUsesProvider(group, child.legacyProviderKey);
      });
      if (reusedElsewhere) {
        throw new Error("旧版代理提供者已被其他代理组引用，无法安全改名：" + child.legacyProviderKey);
      }
    }
  });
  /* CHILD_ONLY_END */

  /* AI_ONLY_START */
  if (!SETTINGS.ai.enabled) {
    return;
  }

  const ruleProviders = config["rule-providers"] || {};
  if (ruleProviders[SETTINGS.ai.providerKey] && !aiProviderMatches(ruleProviders[SETTINGS.ai.providerKey])) {
    throw new Error("AI 规则提供者键冲突：" + SETTINGS.ai.providerKey);
  }

  const aiGroup = findGroup(groups, SETTINGS.ai.groupName);
  if (SETTINGS.ai.mode === "existing" && !aiGroup) {
    throw new Error("未找到已有 AI 代理组：" + SETTINGS.ai.groupName);
  }

  if (SETTINGS.ai.mode === "create" && aiGroup) {
    const rules = Array.isArray(config.rules) ? config.rules : [];
    const managed = aiProviderMatches(ruleProviders[SETTINGS.ai.providerKey]) && rules.includes(aiRuleLine());
    if (!managed) {
      throw new Error("自动 AI 代理组名称冲突：" + SETTINGS.ai.groupName);
    }
  }

  if (SETTINGS.ai.mode === "create" && parent.name === SETTINGS.ai.groupName) {
    throw new Error("自动 AI 代理组不能与主代理组同名。");
  }
  /* AI_ONLY_END */
}

/* AI_ONLY_START */
function cleanOriginalExcludeFilter(group) {
  const generated = new Set(
    SETTINGS.children.concat(SETTINGS.removedChildren).map(function (child) {
      return "(?i)^" + escapeRegex(child.nodePrefix);
    })
  );
  const kept = splitExcludeFilters(group).filter(function (item) {
    return !generated.has(item);
  });
  if (kept.length) {
    return kept.join("\x60");
  }
  return undefined;
}

function snapshotParent(parent) {
  const childGroupNames = new Set(
    SETTINGS.children.concat(SETTINGS.removedChildren).map(function (child) {
      return child.groupName;
    })
  );
  childGroupNames.add(SETTINGS.ai.groupName);
  const childProviderKeys = new Set(
    SETTINGS.children.concat(SETTINGS.removedChildren).flatMap(function (child) {
      return [child.providerKey, child.legacyProviderKey];
    })
  );

  const snapshot = {
    name: SETTINGS.ai.groupName,
    type: "select",
    proxies: (Array.isArray(parent.proxies) ? parent.proxies : []).filter(function (name) {
      return !childGroupNames.has(name);
    }),
    use: (Array.isArray(parent.use) ? parent.use : []).filter(function (key) {
      return !childProviderKeys.has(key);
    }),
  };

  ["include-all", "include-all-proxies", "include-all-providers", "filter"].forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(parent, key)) {
      snapshot[key] = clonePlain(parent[key]);
    }
  });
  const originalExclude = cleanOriginalExcludeFilter(parent);
  if (originalExclude) {
    snapshot["exclude-filter"] = originalExclude;
  }
  return snapshot;
}
/* AI_ONLY_END */

/* CHILD_ONLY_START */
function ensureChildProvider(config, child, prefixRequired) {
  if (child.legacyProviderKey !== child.providerKey) {
    delete config["proxy-providers"][child.legacyProviderKey];
  }
  config["proxy-providers"][child.providerKey] = providerForParent(child, prefixRequired);
}
/* CHILD_ONLY_END */

/* REMOVE_ONLY_START */
function removeExcludeFilter(group, child) {
  const generated = "(?i)^" + escapeRegex(child.nodePrefix);
  const kept = splitExcludeFilters(group).filter(function (item) {
    return item !== generated;
  });
  if (kept.length) {
    group["exclude-filter"] = kept.join("\x60");
  } else {
    delete group["exclude-filter"];
  }
}

function removeManagedChild(config, groups, parent, child) {
  parent.proxies = (Array.isArray(parent.proxies) ? parent.proxies : []).filter(function (name) {
    return name !== child.groupName;
  });
  removeExcludeFilter(parent, child);

  const groupIndex = groups.findIndex(function (group) {
    return group && group.name === child.groupName;
  });
  if (groupIndex >= 0) {
    groups.splice(groupIndex, 1);
  }
  if (config["proxy-providers"]) {
    delete config["proxy-providers"][child.providerKey];
    delete config["proxy-providers"][child.legacyProviderKey];
  }
}
/* REMOVE_ONLY_END */

/* CHILD_ONLY_START */
function ensureChildGroup(groups, child) {
  let group = findGroup(groups, child.groupName);
  if (!group) {
    group = { name: child.groupName, type: "select", use: [child.providerKey] };
    groups.push(group);
  }
  group.type = "select";
  group.use = [child.providerKey];
  [
    "proxies",
    "include-all",
    "include-all-proxies",
    "include-all-providers",
    "filter",
    "exclude-filter"
  ].forEach(function (key) {
    delete group[key];
  });
  return group;
}
/* CHILD_ONLY_END */

function excludeNestedNodes(group) {
  if (!hasIncludeAll(group)) {
    return;
  }
  /* CHILD_ONLY_START */
  SETTINGS.children.forEach(function (child) {
    appendExcludeFilter(group, "(?i)^" + escapeRegex(child.nodePrefix));
  });
  /* CHILD_ONLY_END */
}

/* AI_ONLY_START */
function applyAiPreset(config, groups, parentSnapshot) {
  if (!SETTINGS.ai.enabled) {
    return;
  }

  config["rule-providers"] = config["rule-providers"] || {};
  config["rule-providers"][SETTINGS.ai.providerKey] = clonePlain(SETTINGS.ai.provider);

  if (SETTINGS.ai.mode === "create") {
    let aiGroup = findGroup(groups, SETTINGS.ai.groupName);
    if (!aiGroup) {
      aiGroup = parentSnapshot;
      groups.push(aiGroup);
    } else {
      Object.keys(aiGroup).forEach(function (key) {
        delete aiGroup[key];
      });
      Object.assign(aiGroup, parentSnapshot);
    }
    excludeNestedNodes(aiGroup);
  }

  const additions = SETTINGS.ai.customDomains.map(function (domain) {
    return "DOMAIN-SUFFIX," + domain + "," + SETTINGS.ai.groupName;
  });
  additions.push(aiRuleLine());
  const additionSet = new Set(additions);
  const originalRules = Array.isArray(config.rules) ? config.rules : [];
  config.rules = additions.concat(originalRules.filter(function (rule) {
    return !additionSet.has(rule);
  }));
}
/* AI_ONLY_END */

function main(config, profileName) {
  if (profileName !== SETTINGS.targetProfileName) {
    console.warn(
      "Clash Verge Kit：当前配置不是目标主订阅，已跳过：" + String(profileName || "未命名")
    );
    return config;
  }
  if (!config || typeof config !== "object") {
    throw new Error("配置对象无效。");
  }

  const groups = Array.isArray(config["proxy-groups"])
    ? config["proxy-groups"]
    : [];
  const parent = resolveParent(config, groups);
  /* CHILD_ONLY_START */
  const prefixRequired = hasIncludeAll(parent);
  /* CHILD_ONLY_END */

  preflight(config, groups, parent);
  config["proxy-groups"] = groups;
  config["proxy-providers"] = config["proxy-providers"] || {};
  parent.proxies = Array.isArray(parent.proxies) ? parent.proxies : [];
  /* REMOVE_ONLY_START */
  SETTINGS.removedChildren.forEach(function (child) {
    removeManagedChild(config, groups, parent, child);
  });
  /* REMOVE_ONLY_END */
  /* AI_ONLY_START */
  const parentSnapshot = snapshotParent(parent);
  /* AI_ONLY_END */

  /* CHILD_ONLY_START */
  SETTINGS.children.forEach(function (child) {
    ensureChildProvider(config, child, prefixRequired);
    ensureChildGroup(groups, child);
    if (!parent.proxies.includes(child.groupName)) {
      parent.proxies.push(child.groupName);
    }
  });
  /* CHILD_ONLY_END */
  excludeNestedNodes(parent);
  /* AI_ONLY_START */
  applyAiPreset(config, groups, parentSnapshot);
  /* AI_ONLY_END */
  return config;
}
`;
  return formatReadableRuntimeScript(runtime
    .replace(
      /\/\* AI_ONLY_START \*\/([\s\S]*?)\/\* AI_ONLY_END \*\//g,
      settings.ai.enabled ? "$1" : "",
    )
    .replace(
      /\/\* REMOVE_ONLY_START \*\/([\s\S]*?)\/\* REMOVE_ONLY_END \*\//g,
      settings.removedChildren.length ? "$1" : "",
    )
    .replace(
      /\/\* CHILD_ONLY_START \*\/([\s\S]*?)\/\* CHILD_ONLY_END \*\//g,
      settings.children.length ? "$1" : "",
    ));
}

function buildRuntimeSettings(spec: GeneratorSpec, diagnostics: Diagnostic[]): RuntimeSettings {
  const targetProfileName = spec.targetProfile.name.trim();
  const targetProfileSource = spec.targetProfile.source.trim();
  if (!targetProfileName) {
    diagnostics.push(
      diagnostic(
        "target-profile-name-required",
        "error",
        "目标主订阅名称不能为空；请填写 Clash Verge Rev 中显示的订阅名称。",
        "Target main profile name is required; enter the name shown in Clash Verge Rev.",
        "targetProfile.name",
      ),
    );
  } else if (/\r|\n/.test(targetProfileName)) {
    diagnostics.push(
      diagnostic(
        "target-profile-name-line-break",
        "error",
        "目标主订阅名称不能包含换行。",
        "Target main profile name cannot contain line breaks.",
        "targetProfile.name",
      ),
    );
  }

  const targetSourceIdentity = normalizeSourceIdentity(targetProfileSource);
  if (!targetProfileSource) {
    diagnostics.push(
      diagnostic(
        "target-profile-source-required",
        "error",
        "请填写目标主订阅来源，以便阻止主订阅套入自身。",
        "Enter the target main profile source so self-nesting can be blocked.",
        "targetProfile.source",
      ),
    );
  } else if (!targetSourceIdentity) {
    diagnostics.push(
      diagnostic(
        "target-profile-source-invalid",
        "error",
        "目标主订阅来源必须是有效的 HTTP(S) 地址或 ./profiles/ 下的 YAML 文件。",
        "The target profile source must be a valid HTTP(S) URL or a YAML file under ./profiles/.",
        "targetProfile.source",
      ),
    );
  }

  const parentGroupMode = spec.parentGroupMode === "auto" ? "auto" : "manual";
  const parentGroupName = parentGroupMode === "manual"
    ? validateGroupName(
        spec.parentGroupName,
        "parentGroupName",
        diagnostics,
        "主代理组名称",
        "Parent group name",
      )
    : "";

  if (!spec.children.length && !spec.removedChildren?.length) {
    diagnostics.push(
      diagnostic("child-required", "error", "至少需要一个子订阅。", "At least one nested subscription is required.", "children"),
    );
  }
  if (spec.children.length > MAX_MANAGED_CHILDREN) {
    diagnostics.push(
      diagnostic(
        "child-limit-exceeded",
        "error",
        `最多支持 ${MAX_MANAGED_CHILDREN} 个子订阅。`,
        `At most ${MAX_MANAGED_CHILDREN} child subscriptions are supported.`,
        "children",
      ),
    );
  }
  if ((spec.removedChildren?.length ?? 0) > MAX_MANAGED_CHILDREN) {
    diagnostics.push(
      diagnostic(
        "removed-child-limit-exceeded",
        "error",
        `最多支持 ${MAX_MANAGED_CHILDREN} 个待移除子订阅。`,
        `At most ${MAX_MANAGED_CHILDREN} removed child subscriptions are supported.`,
        "removedChildren",
      ),
    );
  }
  const seenGroups = new Set<string>();
  const seenChildSources = new Set<string>();
  const children = spec.children.map((child, index): RuntimeChild => {
    const fieldBase = `children.${index}`;
    const groupName = validateGroupName(
      child.groupName,
      `${fieldBase}.groupName`,
      diagnostics,
      `第 ${index + 1} 个子组名称`,
      `Nested group ${index + 1} name`,
    );
    const source = child.source.trim();
    const childSourceIdentity = normalizeSourceIdentity(source);
    if (targetSourceIdentity && childSourceIdentity === targetSourceIdentity) {
      diagnostics.push(
        diagnostic(
          "self-nesting-source",
          "error",
          `第 ${index + 1} 个子订阅与目标主订阅来源相同，已阻止自己套自己。`,
          `Nested subscription ${index + 1} is the same source as the target profile. Self-nesting was blocked.`,
          `${fieldBase}.source`,
        ),
      );
    }
    if (childSourceIdentity && seenChildSources.has(childSourceIdentity)) {
      diagnostics.push(
        diagnostic(
          "duplicate-child-source",
          "error",
          `第 ${index + 1} 个子订阅来源重复。`,
          `Nested subscription ${index + 1} uses a duplicate source.`,
          `${fieldBase}.source`,
        ),
      );
    }
    if (childSourceIdentity) seenChildSources.add(childSourceIdentity);
    if (groupName === parentGroupName && groupName) {
      diagnostics.push(
        diagnostic(
          "child-parent-name-conflict",
          "error",
          "子组不能与主代理组同名。",
          "A nested group cannot have the same name as the parent group.",
          `${fieldBase}.groupName`,
        ),
      );
    }
    if (seenGroups.has(groupName) && groupName) {
      diagnostics.push(
        diagnostic(
          "duplicate-child-group",
          "error",
          "子组名称不能重复。",
          "Nested group names must be unique.",
          `${fieldBase}.groupName`,
        ),
      );
    }
    seenGroups.add(groupName);

    if (child.mode === "http" && !validateHttpSource(source)) {
      diagnostics.push(
        diagnostic(
          "invalid-http-source",
          "error",
          "订阅链接必须是有效的 HTTP 或 HTTPS 地址。",
          "The subscription must be a valid HTTP or HTTPS URL.",
          `${fieldBase}.source`,
        ),
      );
    }
    if (child.mode === "file" && !isSafeFileProviderPath(source)) {
      diagnostics.push(
        diagnostic(
          "invalid-file-source",
          "error",
          "文件提供者仅允许 ./profiles/ 下的安全 YAML 文件名。",
          "File providers must use a safe YAML filename inside ./profiles/.",
          `${fieldBase}.source`,
        ),
      );
    }

    const legacyProviderKey = `clash_verge_kit_${stableHash(`provider:${groupName}`)}`;
    const providerKey = groupName;
    const nodePrefix = child.nodePrefix?.trim() || deriveNodePrefix(groupName);
    return {
      providerKey,
      legacyProviderKey,
      groupName,
      nodePrefix,
      provider: createProvider(child.mode, source, legacyProviderKey),
    };
  });

  const seenRemovedGroups = new Set<string>();
  const removedChildren = (spec.removedChildren ?? []).map((child, index): RuntimeRemovedChild => {
    const fieldBase = `removedChildren.${index}`;
    const groupName = validateGroupName(
      child.groupName,
      `${fieldBase}.groupName`,
      diagnostics,
      `第 ${index + 1} 个待移除子组名称`,
      `Removed nested group ${index + 1} name`,
    );
    const expected = {
      providerKey: groupName,
      legacyProviderKey: `clash_verge_kit_${stableHash(`provider:${groupName}`)}`,
    };
    if (
      child.providerKey !== expected.providerKey ||
      child.legacyProviderKey !== expected.legacyProviderKey ||
      !/^[0-9a-f]{8}$/.test(child.sourceHash)
    ) {
      diagnostics.push(diagnostic(
        "invalid-removal-signature",
        "error",
        `第 ${index + 1} 个待移除子订阅签名无效。`,
        `Removed nested subscription ${index + 1} has an invalid signature.`,
        fieldBase,
      ));
    }
    if (seenGroups.has(groupName) && groupName) {
      diagnostics.push(diagnostic(
        "kept-removed-child-conflict",
        "error",
        "同一个子组不能同时保留和移除。",
        "The same nested group cannot be kept and removed.",
        `${fieldBase}.groupName`,
      ));
    }
    if (seenRemovedGroups.has(groupName) && groupName) {
      diagnostics.push(diagnostic(
        "duplicate-removed-child",
        "error",
        "待移除子组名称不能重复。",
        "Removed nested group names must be unique.",
        `${fieldBase}.groupName`,
      ));
    }
    seenRemovedGroups.add(groupName);
    return {
      groupName,
      nodePrefix: child.nodePrefix.trim() ? child.nodePrefix : deriveNodePrefix(groupName),
      providerKey: expected.providerKey,
      legacyProviderKey: expected.legacyProviderKey,
      providerMode: child.providerMode,
      sourceHash: child.sourceHash,
    };
  });

  const aiGroupName = spec.ai.enabled
    ? validateGroupName(spec.ai.groupName, "ai.groupName", diagnostics, "AI 代理组名称", "AI group name")
    : spec.ai.groupName.trim();
  if (spec.ai.enabled && spec.ai.mode === "create") {
    if (aiGroupName === parentGroupName) {
      diagnostics.push(
        diagnostic(
          "ai-parent-name-conflict",
          "error",
          "自动创建的 AI 组不能与主代理组同名。",
          "An auto-created AI group cannot have the same name as the parent group.",
          "ai.groupName",
        ),
      );
    }
    if (seenGroups.has(aiGroupName)) {
      diagnostics.push(
        diagnostic(
          "ai-child-name-conflict",
          "error",
          "自动创建的 AI 组不能与子组同名。",
          "An auto-created AI group cannot have the same name as a nested group.",
          "ai.groupName",
        ),
      );
    }
  }

  const normalizedDomains: string[] = [];
  const seenDomains = new Set<string>();
  if (spec.ai.enabled) {
    spec.ai.customDomains.forEach((raw, index) => {
      if (!raw.trim()) {
        return;
      }
      const normalized = normalizeDomainSuffix(raw);
      if (!normalized) {
        diagnostics.push(
          diagnostic(
            "invalid-ai-domain",
            "error",
            `第 ${index + 1} 个自定义 AI 域名无效。`,
            `Custom AI domain ${index + 1} is invalid.`,
            "ai.customDomains",
          ),
        );
        return;
      }
      if (!seenDomains.has(normalized)) {
        normalizedDomains.push(normalized);
        seenDomains.add(normalized);
      }
    });
  }

  const aiProviderKey = `clash_verge_kit_ai_${stableHash(`ai:${aiGroupName || "default"}`)}`;
  return {
    targetProfileName,
    parentGroupMode,
    parentGroupName,
    children,
    removedChildren,
    ai: {
      enabled: spec.ai.enabled,
      mode: spec.ai.mode,
      groupName: aiGroupName,
      customDomains: normalizedDomains,
      providerKey: aiProviderKey,
      provider: {
        type: "http",
        behavior: "domain",
        format: "mrs",
        url: AI_RULESET_URL,
        path: "./rule_provider/clash-verge-kit/category-ai-!cn.mrs",
        interval: 86400,
      },
    },
  };
}

function maskedSettings(settings: RuntimeSettings): RuntimeSettings {
  return {
    ...settings,
    children: settings.children.map((child) => ({
      ...child,
      provider:
        child.provider.type === "http"
          ? { ...child.provider, url: maskSubscriptionUrl(String(child.provider.url ?? "")) }
          : { ...child.provider },
    })),
  };
}

export function generateClashVergeScript(spec: GeneratorSpec): GenerationResult {
  const diagnostics: Diagnostic[] = [];
  const settings = buildRuntimeSettings(spec, diagnostics);
  const topology: TopologySummary = {
    targetProfileName: settings.targetProfileName,
    parentGroupMode: settings.parentGroupMode,
    parentGroupName: settings.parentGroupName,
    children: settings.children.map((child, index) => ({
      groupName: child.groupName || `#${index + 1}`,
      providerMode: spec.children[index]?.mode ?? "http",
      nodePrefix: child.nodePrefix,
    })),
    removedChildren: settings.removedChildren.map((child) => child.groupName),
    keptCount: settings.children.length,
    removedCount: settings.removedChildren.length,
    aiEnabled: settings.ai.enabled,
    aiGroupName: settings.ai.enabled ? settings.ai.groupName : undefined,
  };

  const operation = settings.removedChildren.length
    ? settings.children.length ? "update" : "restore"
    : "apply";

  const valid = !diagnostics.some((item) => item.severity === "error");
  if (!valid) {
    return { valid, operation, fullScript: "", maskedScript: "", diagnostics, topology };
  }

  diagnostics.push(
    diagnostic(
      "ready",
      "success",
      operation === "apply"
        ? "输入校验通过，脚本可在 Clash Verge Rev 中使用。"
        : operation === "update"
          ? `更新脚本已生成：保留 ${settings.children.length} 个，移除 ${settings.removedChildren.length} 个子订阅。`
          : "复原脚本已生成：子订阅将全部剥离，AI 设置保持不变。",
      operation === "apply"
        ? "Validation passed. The script is ready for Clash Verge Rev."
        : operation === "update"
          ? `Update script generated: keep ${settings.children.length}, remove ${settings.removedChildren.length}.`
          : "Restore script generated: all nested subscriptions will be removed and AI settings preserved.",
    ),
  );
  return {
    valid,
    operation,
    fullScript: buildRuntimeScript(settings, createManagementMetadataBlock(spec)),
    maskedScript: buildRuntimeScript(
      maskedSettings(settings),
      createManagementMetadataBlock(redactManagedSpec(spec)),
    ),
    diagnostics,
    topology,
  };
}
