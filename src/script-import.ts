import { sha256Hex } from "./integrity.ts";
import type { GeneratorSpec, RemovedChildSubscription } from "./types";

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_MANAGED_CHILDREN = 64;
const METADATA_SCHEMA = "clash-verge-kit/managed-script";
const METADATA_VERSION = 1;
const BLOCK_PATTERN = /\/\* CLASH_VERGE_KIT_MANAGEMENT_V(\d+)\r?\n([A-Za-z0-9_-]+)\r?\nCLASH_VERGE_KIT_MANAGEMENT_END \*\//g;

export type ScriptImportErrorCode =
  | "file-too-large"
  | "metadata-missing"
  | "metadata-duplicate"
  | "metadata-malformed"
  | "version-unsupported"
  | "integrity-mismatch"
  | "schema-invalid";

export type ScriptImportResult =
  | { ok: true; spec: GeneratorSpec }
  | { ok: false; error: { code: ScriptImportErrorCode } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanLine(value: unknown, maxLength = 128, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if ((!allowEmpty && !cleaned) || cleaned.length > maxLength || /[\r\n]/.test(cleaned)) return null;
  return cleaned;
}

function validSource(value: string, mode?: "http" | "file"): boolean {
  if (value.length > 4_096) return false;
  if (mode === "file" || value.startsWith("./profiles/")) {
    return /^\.\/profiles\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/i.test(value) && !value.includes("..");
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function normalizeRemovedChild(value: unknown): RemovedChildSubscription | null {
  if (!isRecord(value)) return null;
  const groupName = cleanLine(value.groupName);
  const nodePrefix = cleanLine(value.nodePrefix);
  const providerKey = cleanLine(value.providerKey);
  const legacyProviderKey = cleanLine(value.legacyProviderKey);
  if (
    !groupName || !nodePrefix || !providerKey || !legacyProviderKey
    || (value.providerMode !== "http" && value.providerMode !== "file")
    || typeof value.sourceHash !== "string" || !/^[0-9a-f]{8}$/.test(value.sourceHash)
  ) return null;
  return {
    groupName,
    nodePrefix,
    providerKey,
    legacyProviderKey,
    providerMode: value.providerMode,
    sourceHash: value.sourceHash,
  };
}

export function normalizeManagedSpec(value: unknown): GeneratorSpec | null {
  if (!isRecord(value) || !isRecord(value.targetProfile) || !isRecord(value.ai)) return null;
  const targetName = cleanLine(value.targetProfile.name);
  const targetSource = cleanLine(value.targetProfile.source, 4_096);
  if (!targetName || !targetSource || !validSource(targetSource)) return null;
  if (value.parentGroupMode !== "auto" && value.parentGroupMode !== "manual") return null;
  const parentGroupName = value.parentGroupMode === "manual"
    ? cleanLine(value.parentGroupName)
    : "";
  if (parentGroupName === null) return null;

  if (!Array.isArray(value.children) || value.children.length > MAX_MANAGED_CHILDREN) return null;
  const seenIds = new Set<string>();
  const children = [] as GeneratorSpec["children"];
  for (const candidate of value.children) {
    if (!isRecord(candidate)) return null;
    const id = cleanLine(candidate.id);
    const groupName = cleanLine(candidate.groupName);
    const source = cleanLine(candidate.source, 4_096);
    if (
      !id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || seenIds.has(id)
      || !groupName || /,/.test(groupName)
      || (candidate.mode !== "http" && candidate.mode !== "file")
      || !source || !validSource(source, candidate.mode)
    ) return null;
    const nodePrefix = candidate.nodePrefix === undefined ? undefined : cleanLine(candidate.nodePrefix);
    if (candidate.nodePrefix !== undefined && !nodePrefix) return null;
    seenIds.add(id);
    children.push({
      id,
      groupName,
      mode: candidate.mode,
      source,
      ...(nodePrefix ? { nodePrefix } : {}),
    });
  }

  const removedInput = value.removedChildren === undefined ? [] : value.removedChildren;
  if (!Array.isArray(removedInput) || removedInput.length > MAX_MANAGED_CHILDREN) return null;
  const removedChildren = removedInput.map(normalizeRemovedChild);
  if (removedChildren.some((child) => !child) || children.length + removedChildren.length === 0) return null;

  if (typeof value.ai.enabled !== "boolean" || (value.ai.mode !== "existing" && value.ai.mode !== "create")) return null;
  const aiGroupName = cleanLine(value.ai.groupName, 128, !value.ai.enabled);
  if (aiGroupName === null || !Array.isArray(value.ai.customDomains) || value.ai.customDomains.length > 256) return null;
  const customDomains: string[] = [];
  for (const domain of value.ai.customDomains) {
    const cleaned = cleanLine(domain, 253);
    if (!cleaned) return null;
    customDomains.push(cleaned);
  }

  return {
    targetProfile: { name: targetName, source: targetSource },
    parentGroupMode: value.parentGroupMode,
    parentGroupName,
    children,
    removedChildren: removedChildren as RemovedChildSubscription[],
    ai: {
      enabled: value.ai.enabled,
      mode: value.ai.mode,
      groupName: aiGroupName,
      customDomains,
    },
  };
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string | null {
  try {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function checksumPayload(spec: GeneratorSpec): string {
  return JSON.stringify({ schema: METADATA_SCHEMA, version: METADATA_VERSION, spec });
}

export function createManagementMetadataBlock(spec: GeneratorSpec): string {
  const normalized = normalizeManagedSpec(spec);
  if (!normalized) throw new Error("invalid-management-spec");
  const payload = checksumPayload(normalized);
  const envelope = JSON.stringify({
    schema: METADATA_SCHEMA,
    version: METADATA_VERSION,
    checksum: { algorithm: "sha256", value: sha256Hex(payload) },
    spec: normalized,
  });
  return `/* CLASH_VERGE_KIT_MANAGEMENT_V1\n${encodeBase64Url(envelope)}\nCLASH_VERGE_KIT_MANAGEMENT_END */`;
}

export function redactManagedSpec(spec: GeneratorSpec): GeneratorSpec {
  const normalized = normalizeManagedSpec(spec);
  if (!normalized) throw new Error("invalid-management-spec");
  return {
    ...normalized,
    targetProfile: {
      ...normalized.targetProfile,
      source: normalized.targetProfile.source.startsWith("./profiles/")
        ? normalized.targetProfile.source
        : "https://redacted.invalid/target",
    },
    children: normalized.children.map((child) => ({
      ...child,
      source: child.mode === "file" ? child.source : "https://redacted.invalid/nested",
    })),
  };
}

function failure(code: ScriptImportErrorCode): ScriptImportResult {
  return { ok: false, error: { code } };
}

export function parseManagedScript(script: string): ScriptImportResult {
  if (typeof script !== "string" || new TextEncoder().encode(script).byteLength > MAX_SCRIPT_BYTES) {
    return failure("file-too-large");
  }
  const markerCount = script.match(/\/\*\s*CLASH_VERGE_KIT_MANAGEMENT_V\d+/g)?.length ?? 0;
  if (markerCount > 1) return failure("metadata-duplicate");
  const matches = [...script.matchAll(BLOCK_PATTERN)];
  if (matches.length > 1) return failure("metadata-duplicate");
  if (!matches.length) {
    return script.includes("CLASH_VERGE_KIT_MANAGEMENT_V")
      ? failure("metadata-malformed")
      : failure("metadata-missing");
  }
  if (matches[0]![1] !== String(METADATA_VERSION)) return failure("version-unsupported");
  const decoded = decodeBase64Url(matches[0]![2]!);
  if (!decoded) return failure("metadata-malformed");
  let envelope: unknown;
  try {
    envelope = JSON.parse(decoded);
  } catch {
    return failure("metadata-malformed");
  }
  if (!isRecord(envelope)) return failure("schema-invalid");
  if (envelope.schema !== METADATA_SCHEMA || envelope.version !== METADATA_VERSION) return failure("schema-invalid");
  if (!isRecord(envelope.checksum) || envelope.checksum.algorithm !== "sha256") return failure("schema-invalid");
  if (typeof envelope.checksum.value !== "string" || !/^[0-9a-f]{64}$/.test(envelope.checksum.value)) {
    return failure("schema-invalid");
  }
  const spec = normalizeManagedSpec(envelope.spec);
  if (!spec) return failure("schema-invalid");
  if (sha256Hex(checksumPayload(spec)) !== envelope.checksum.value) return failure("integrity-mismatch");
  return { ok: true, spec };
}
