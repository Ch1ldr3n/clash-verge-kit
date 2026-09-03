import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { parse } from "yaml";
import {
  discoverClashVergeProfileFiles,
  profileFileCandidatesFromUserInput,
} from "./clash-verge-locator.ts";
import {
  createSubscriptionInspectionSummary,
  type LocalProfileCatalogItem,
  type LocalProfileSelection,
  type SubscriptionInspectionSummary,
} from "../src/subscription-inspection.ts";
import {
  cleanProfileName,
  inspectProfileYaml,
  type ProfileYamlInspection,
} from "./profile-yaml.ts";
import { classifyManagedScript } from "../src/managed-script-integrity.ts";

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_INDEX_BYTES = 5 * 1024 * 1024;

interface LocalProfileRecord {
  id: string;
  name: string;
  source: string;
  profileFilePath?: string;
  scriptUid?: string;
  scriptFilePath?: string;
  isCurrent: boolean;
}

interface CachedProfiles {
  filePath: string;
  mtimeMs: number;
  profilesBySource: Map<string, LocalProfileRecord>;
  profilesById: Map<string, LocalProfileRecord>;
  catalog: LocalProfileCatalogItem[];
}

interface CachedProfileInspection extends ProfileYamlInspection {
  mtimeMs: number;
}

export interface LocalProfileRepository {
  list(): Promise<LocalProfileCatalogItem[]>;
  select(profileId: string): Promise<LocalProfileSelection | null>;
  findBySource(source: string): Promise<LocalProfileSelection | null>;
  addProfileLocation?(input: string): Promise<ProfileLocationAddResult>;
  installManagedScript(profileId: string, script: string): Promise<ManagedScriptInstallResult>;
}

export type ProfileLocationAddResult =
  | { status: "loaded"; profileCount: number }
  | { status: "not-found" };

export type ManagedScriptInstallResult =
  | { status: "written"; targetIsCurrent: boolean }
  | { status: "target-missing" }
  | { status: "script-not-linked" }
  | { status: "unsafe-script-path" }
  | { status: "custom-script-conflict" }
  | { status: "invalid-script" }
  | { status: "concurrent-change" }
  | { status: "write-failed" };

export interface LocalProfileRepositoryOptions {
  profileFileCandidates?: () => readonly string[] | Promise<readonly string[]>;
}

export function normalizeProfileSource(source: string): string | null {
  try {
    const parsed = new URL(source.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return null;
  }
}

export function findProfileNameInYaml(yamlSource: string, source: string): string | null {
  const target = normalizeProfileSource(source);
  if (!target) return null;
  const root = parse(yamlSource) as { items?: unknown } | null;
  if (!root || !Array.isArray(root.items)) return null;

  for (const candidate of root.items) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    if (typeof item.url !== "string" || normalizeProfileSource(item.url) !== target) continue;
    return cleanProfileName(item.name);
  }
  return null;
}

function safeProfileFilePath(profilesFilePath: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/i.test(value)) return undefined;
  if (path.basename(value) !== value) return undefined;
  return path.join(path.dirname(profilesFilePath), "profiles", value);
}

function safeScriptFilePath(profilesFilePath: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !/^s[A-Za-z0-9]+\.js$/.test(value)) return undefined;
  if (path.basename(value) !== value) return undefined;
  return path.join(path.dirname(profilesFilePath), "profiles", value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readScriptUid(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.script !== "string") return undefined;
  const uid = value.script.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(uid) ? uid : undefined;
}

function buildCachedProfiles(
  filePath: string,
  mtimeMs: number,
  yamlSource: string,
  previous: CachedProfiles | null,
): CachedProfiles {
  const root = parse(yamlSource) as { current?: unknown; items?: unknown } | null;
  const currentUid = typeof root?.current === "string" ? root.current : null;
  const items = Array.isArray(root?.items)
    ? root.items.filter(isRecord)
    : [];
  const itemsByUid = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    if (typeof item.uid === "string" && item.uid.trim()) itemsByUid.set(item.uid, item);
  }

  const profilesBySource = new Map<string, LocalProfileRecord>();
  const profilesById = new Map<string, LocalProfileRecord>();
  const catalog: LocalProfileCatalogItem[] = [];
  for (const item of items) {
    const source = typeof item.url === "string" ? normalizeProfileSource(item.url) : null;
    const name = cleanProfileName(item.name);
    if (!source || !name || profilesBySource.has(source)) continue;

    const uid = typeof item.uid === "string" ? item.uid : undefined;
    const scriptUid = readScriptUid(item.option);
    const scriptItem = scriptUid ? itemsByUid.get(scriptUid) : undefined;
    const scriptFilePath = scriptItem?.type === "script"
      ? safeScriptFilePath(filePath, scriptItem.file)
      : undefined;
    const record: LocalProfileRecord = {
      id: previous?.profilesBySource.get(source)?.id ?? randomUUID(),
      name,
      source,
      profileFilePath: safeProfileFilePath(filePath, item.file),
      scriptUid,
      scriptFilePath,
      isCurrent: Boolean(uid && currentUid === uid),
    };
    profilesBySource.set(source, record);
    profilesById.set(record.id, record);
    catalog.push({
      id: record.id,
      name: record.name,
      status: "available",
      ...(record.isCurrent ? { isCurrent: true as const } : {}),
    });
  }

  return { filePath, mtimeMs, profilesBySource, profilesById, catalog };
}

function isOfficialDefaultScript(script: string): boolean {
  const withoutLeadingComment = script.replace(/^\s*\/\/[^\r\n]*(?:\r?\n|$)/, "").trim();
  return /^function\s+main\s*\(\s*config\s*,\s*profileName\s*\)\s*\{\s*return\s+config\s*;?\s*\}\s*;?$/.test(
    withoutLeadingComment,
  );
}

type ScriptSnapshot =
  | { status: "ok"; content: string; exists: boolean }
  | { status: "unsafe" };

async function readScriptSnapshot(filePath: string): Promise<ScriptSnapshot> {
  try {
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > MAX_SCRIPT_BYTES) {
      return { status: "unsafe" };
    }
    return { status: "ok", content: await readFile(filePath, "utf8"), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "ok", content: "", exists: false };
    }
    return { status: "unsafe" };
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function isSafeLinkedScriptPath(profilesFilePath: string, scriptFilePath: string): Promise<boolean> {
  try {
    const dataDirectory = path.dirname(profilesFilePath);
    const profilesDirectory = path.join(dataDirectory, "profiles");
    const profilesStat = await lstat(profilesDirectory);
    if (profilesStat.isSymbolicLink() || !profilesStat.isDirectory()) return false;

    const [dataDirectoryReal, profilesDirectoryReal, scriptFileReal, scriptStat] = await Promise.all([
      realpath(dataDirectory),
      realpath(profilesDirectory),
      realpath(scriptFilePath),
      lstat(scriptFilePath),
    ]);
    if (scriptStat.isSymbolicLink() || !scriptStat.isFile()) return false;
    if (!sameResolvedPath(profilesDirectoryReal, path.join(dataDirectoryReal, "profiles"))) return false;
    return sameResolvedPath(path.dirname(scriptFileReal), profilesDirectoryReal);
  } catch {
    return false;
  }
}

function emptyProfiles(): CachedProfiles {
  return {
    filePath: "",
    mtimeMs: 0,
    profilesBySource: new Map(),
    profilesById: new Map(),
    catalog: [],
  };
}

function unavailableProfileInspection(): ProfileYamlInspection {
  return {
    format: "unknown",
    profileName: null,
    selectGroups: [],
    suggestedGroup: null,
    terminalGroup: null,
    nodeCount: null,
    warnings: ["profile-yaml-unavailable", "select-groups-unavailable", "node-count-unavailable"],
  };
}

export function createLocalProfileRepository(
  options: LocalProfileRepositoryOptions = {},
): LocalProfileRepository {
  let discoveredProfileFiles: Promise<readonly string[]> | null = null;
  const manualProfileFiles: string[] = [];
  let cachedProfiles: CachedProfiles | null = null;
  const cachedProfileInspections = new Map<string, CachedProfileInspection>();

  async function profileFileCandidates(): Promise<readonly string[]> {
    discoveredProfileFiles ??= Promise.resolve(
      options.profileFileCandidates ? options.profileFileCandidates() : discoverClashVergeProfileFiles(),
    );
    return [...manualProfileFiles, ...await discoveredProfileFiles];
  }

  async function readProfilesCandidate(
    filePath: string,
    previous: CachedProfiles | null,
  ): Promise<CachedProfiles | null> {
    try {
      const fileStat = await lstat(filePath);
      if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > MAX_PROFILE_INDEX_BYTES) return null;
      if (previous?.filePath === filePath && previous.mtimeMs === fileStat.mtimeMs) return previous;
      const yamlSource = await readFile(filePath, "utf8");
      return buildCachedProfiles(filePath, fileStat.mtimeMs, yamlSource, previous);
    } catch {
      return null;
    }
  }

  async function loadProfiles(): Promise<CachedProfiles> {
    for (const filePath of await profileFileCandidates()) {
      const loaded = await readProfilesCandidate(filePath, cachedProfiles);
      if (loaded) {
        cachedProfiles = loaded;
        return cachedProfiles;
      }
    }
    return emptyProfiles();
  }

  async function loadProfileInspection(profileFilePath: string | undefined): Promise<ProfileYamlInspection> {
    if (!profileFilePath) return unavailableProfileInspection();
    try {
      const fileStat = await lstat(profileFilePath);
      if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > 5 * 1024 * 1024) {
        return unavailableProfileInspection();
      }
      const cached = cachedProfileInspections.get(profileFilePath);
      if (cached?.mtimeMs === fileStat.mtimeMs) {
        const { mtimeMs: _mtimeMs, ...inspection } = cached;
        return inspection;
      }
      const inspection = inspectProfileYaml(await readFile(profileFilePath, "utf8"));
      cachedProfileInspections.set(profileFilePath, { ...inspection, mtimeMs: fileStat.mtimeMs });
      return inspection;
    } catch {
      return unavailableProfileInspection();
    }
  }

  async function inspectLocalProfile(profile: LocalProfileRecord): Promise<SubscriptionInspectionSummary> {
    const inspection = await loadProfileInspection(profile.profileFilePath);
    return createSubscriptionInspectionSummary({
      name: profile.name,
      nameSource: "local",
      origin: "local",
      ...inspection,
    });
  }

  async function toSelection(profile: LocalProfileRecord): Promise<LocalProfileSelection> {
    return {
      profileId: profile.id,
      name: profile.name,
      source: profile.source,
      inspection: await inspectLocalProfile(profile),
    };
  }

  return {
    async list() {
      return [...(await loadProfiles()).catalog];
    },
    async select(profileId) {
      const profile = (await loadProfiles()).profilesById.get(profileId);
      return profile ? toSelection(profile) : null;
    },
    async findBySource(source) {
      const normalized = normalizeProfileSource(source);
      if (!normalized) return null;
      const profile = (await loadProfiles()).profilesBySource.get(normalized);
      return profile ? toSelection(profile) : null;
    },
    async addProfileLocation(input) {
      for (const filePath of profileFileCandidatesFromUserInput(input)) {
        const loaded = await readProfilesCandidate(filePath, null);
        if (!loaded || loaded.catalog.length === 0) continue;
        manualProfileFiles.splice(0, manualProfileFiles.length, filePath);
        cachedProfiles = loaded;
        return { status: "loaded", profileCount: loaded.catalog.length };
      }
      return { status: "not-found" };
    },
    async installManagedScript(profileId, script) {
      if (classifyManagedScript(script) !== "current-readable") return { status: "invalid-script" };
      try {
        new vm.Script(script);
      } catch {
        return { status: "invalid-script" };
      }

      try {
        const cached = await loadProfiles();
        const selected = cached.profilesById.get(profileId);
        if (!selected || !cached.filePath) return { status: "target-missing" };

        const profilesSource = await readFile(cached.filePath, "utf8");
        const live = buildCachedProfiles(cached.filePath, cached.mtimeMs, profilesSource, cached);
        const target = live.profilesBySource.get(selected.source);
        if (!target) return { status: "target-missing" };
        if (!target.scriptUid) return { status: "script-not-linked" };
        if (!target.scriptFilePath) return { status: "unsafe-script-path" };
        if (!await isSafeLinkedScriptPath(cached.filePath, target.scriptFilePath)) {
          return { status: "unsafe-script-path" };
        }

        const existing = await readScriptSnapshot(target.scriptFilePath);
        if (existing.status === "unsafe") return { status: "unsafe-script-path" };
        if (
          existing.content.trim()
          && !isOfficialDefaultScript(existing.content)
          && classifyManagedScript(existing.content) === "invalid"
        ) {
          return { status: "custom-script-conflict" };
        }

        const profilesBeforeWrite = await readFile(cached.filePath, "utf8");
        const scriptBeforeWrite = await readScriptSnapshot(target.scriptFilePath);
        if (
          profilesBeforeWrite !== profilesSource
          || scriptBeforeWrite.status !== "ok"
          || scriptBeforeWrite.exists !== existing.exists
          || scriptBeforeWrite.content !== existing.content
          || !await isSafeLinkedScriptPath(cached.filePath, target.scriptFilePath)
        ) {
          return { status: "concurrent-change" };
        }

        await writeFile(target.scriptFilePath, script, "utf8");
        return { status: "written", targetIsCurrent: target.isCurrent };
      } catch {
        return { status: "write-failed" };
      }
    },
  };
}
