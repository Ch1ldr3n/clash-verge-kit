import { parse } from "yaml";
import type { SubscriptionFormat } from "../src/subscription-inspection.ts";

export interface ProfileGroupMatch {
  selectGroups: string[];
  suggestedGroup: string | null;
}

export interface ProfileYamlInspection extends ProfileGroupMatch {
  format: SubscriptionFormat;
  profileName: string | null;
  terminalGroup: string | null;
  nodeCount: number | null;
  warnings: string[];
}

interface ExtractedProfileGroups extends ProfileGroupMatch {
  terminalGroup: string | null;
  groupsTruncated: boolean;
}

export const MAX_SELECT_GROUPS = 256;
const UNSAFE_TERMINAL_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

export function cleanProfileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 128 || UNSAFE_TERMINAL_NAME.test(name)) return null;
  return name;
}

export function cleanSubscriptionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = cleanProfileName(value
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/\.ya?ml$/i, "")
    .trim());
  if (!name || name.includes(",")) return null;
  return name;
}

function extractSelectGroups(root: Record<string, unknown> | null): ExtractedProfileGroups {
  const groups = root && Array.isArray(root["proxy-groups"]) ? root["proxy-groups"] : [];
  const selectGroups: string[] = [];
  const seen = new Set<string>();
  let groupsTruncated = false;
  for (const candidate of groups) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const group = candidate as Record<string, unknown>;
    const name = cleanProfileName(group.name);
    if (group.type === "select" && name && !seen.has(name)) {
      seen.add(name);
      if (selectGroups.length < MAX_SELECT_GROUPS) selectGroups.push(name);
      else groupsTruncated = true;
    }
  }

  let terminalGroup: string | null = null;
  const rules = root && Array.isArray(root.rules) ? root.rules : [];
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (typeof rule !== "string") continue;
    const parts = rule.split(",");
    const kind = (parts[0] ?? "").trim().toUpperCase();
    const target = (parts[1] ?? "").trim();
    if ((kind === "MATCH" || kind === "FINAL") && seen.has(target)) {
      terminalGroup = target;
      break;
    }
  }

  return {
    selectGroups,
    suggestedGroup: selectGroups.length === 1 ? selectGroups[0]! : null,
    terminalGroup,
    groupsTruncated,
  };
}

export function inspectProfileYaml(yamlSource: string): ProfileYamlInspection {
  const parsed = parse(yamlSource) as unknown;
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const groups = extractSelectGroups(root);
  const isClashYaml = Boolean(root && (
    "proxies" in root
    || "proxy-groups" in root
    || "proxy-providers" in root
    || "rules" in root
  ));
  const nodeCount = root && Array.isArray(root.proxies) ? root.proxies.length : null;
  const warnings: string[] = [];
  if (!isClashYaml) warnings.push("unsupported-format");
  if (groups.selectGroups.length === 0) warnings.push("select-groups-unavailable");
  if (groups.groupsTruncated) warnings.push("select-groups-truncated");
  if (nodeCount === null) warnings.push("node-count-unavailable");

  return {
    format: isClashYaml ? "clash-yaml" : "unknown",
    profileName: cleanSubscriptionName(root?.name ?? root?.title ?? root?.["profile-name"]),
    selectGroups: groups.selectGroups,
    suggestedGroup: groups.suggestedGroup,
    terminalGroup: groups.terminalGroup,
    nodeCount,
    warnings,
  };
}

export function extractSelectGroupsFromYaml(yamlSource: string): ProfileGroupMatch {
  const inspection = inspectProfileYaml(yamlSource);
  return {
    selectGroups: inspection.selectGroups,
    suggestedGroup: inspection.suggestedGroup,
  };
}
