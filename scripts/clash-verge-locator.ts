import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const CLASH_VERGE_APP_ID = "io.github.clash-verge-rev.clash-verge-rev";

const execFileAsync = promisify(execFile);

function pathForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export interface ClashVergeLocatorOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  windowsInstallLocations?: () => Promise<readonly string[]>;
  pathExists?: (candidate: string) => Promise<boolean>;
}

function uniquePaths(values: readonly string[], platform: NodeJS.Platform): string[] {
  const pathApi = pathForPlatform(platform);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = pathApi.resolve(value);
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function cleanWindowsLocation(value: string): string | null {
  const cleaned = value.trim().replace(/^"|"$/g, "").replace(/",?\d+$/, "").trim();
  return path.win32.isAbsolute(cleaned) ? cleaned : null;
}

export async function discoverWindowsClashVergeInstallLocations(): Promise<string[]> {
  const command = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$paths=[System.Collections.Generic.List[string]]::new()",
    "Get-Process -Name 'clash-verge','Clash Verge' | ForEach-Object { if ($_.Path) { $paths.Add($_.Path) } }",
    "$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "Get-ItemProperty -Path $roots | Where-Object { $_.DisplayName -like '*Clash Verge*' } | ForEach-Object { if ($_.InstallLocation) { $paths.Add($_.InstallLocation) }; if ($_.DisplayIcon) { $paths.Add(($_.DisplayIcon -replace '^\"','' -replace '\",?\\d+$','')) } }",
    "$paths | Where-Object { $_ } | Select-Object -Unique",
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
      maxBuffer: 128 * 1024,
    });
    return stdout.split(/\r?\n/).map(cleanWindowsLocation).filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

function portableBaseDirectory(location: string, platform: NodeJS.Platform): string {
  const pathApi = pathForPlatform(platform);
  return pathApi.extname(location).toLowerCase() === ".exe" ? pathApi.dirname(location) : location;
}

function portableProfileCandidate(location: string, platform: NodeJS.Platform): string {
  const pathApi = pathForPlatform(platform);
  const base = portableBaseDirectory(location, platform);
  return pathApi.join(base, ".config", CLASH_VERGE_APP_ID, "profiles.yaml");
}

async function defaultPathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function discoverClashVergeProfileFiles(
  options: ClashVergeLocatorOptions = {},
): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? os.homedir();
  const pathApi = pathForPlatform(platform);
  const candidates: string[] = [];

  if (platform === "win32" && environment.APPDATA) {
    candidates.push(pathApi.join(environment.APPDATA, CLASH_VERGE_APP_ID, "profiles.yaml"));
  } else if (platform === "darwin") {
    candidates.push(pathApi.join(home, "Library", "Application Support", CLASH_VERGE_APP_ID, "profiles.yaml"));
  } else if (platform === "linux") {
    const dataHome = environment.XDG_DATA_HOME || pathApi.join(home, ".local", "share");
    candidates.push(pathApi.join(dataHome, CLASH_VERGE_APP_ID, "profiles.yaml"));
  }

  if (platform === "win32") {
    const locations = await (options.windowsInstallLocations ?? discoverWindowsClashVergeInstallLocations)();
    const pathExists = options.pathExists ?? defaultPathExists;
    const portableLocations = await Promise.all(locations.map(async (location) => {
      const marker = pathApi.join(portableBaseDirectory(location, platform), ".config", "PORTABLE");
      return await pathExists(marker) ? portableProfileCandidate(location, platform) : null;
    }));
    candidates.push(...portableLocations.filter((candidate): candidate is string => Boolean(candidate)));
  }

  return uniquePaths(candidates, platform);
}

export function profileFileCandidatesFromUserInput(
  input: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  let value = input.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return [];

  const pathApi = pathForPlatform(platform);
  const resolved = pathApi.resolve(value);
  if (pathApi.basename(resolved).toLowerCase() === "profiles.yaml") return [resolved];
  const base = pathApi.extname(resolved).toLowerCase() === ".exe" ? pathApi.dirname(resolved) : resolved;
  return uniquePaths([
    pathApi.join(base, "profiles.yaml"),
    pathApi.join(base, ".config", CLASH_VERGE_APP_ID, "profiles.yaml"),
    pathApi.join(base, CLASH_VERGE_APP_ID, "profiles.yaml"),
  ], platform);
}
