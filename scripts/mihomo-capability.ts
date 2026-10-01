import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { discoverWindowsClashVergeInstallLocations } from "./clash-verge-locator.ts";

const run = promisify(execFile);
export function supportsSelectedRouting(version: string | null): boolean {
  const parts = version?.match(/^v?(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (!parts) return false;
  const minimum = [1, 19, 29];
  for (let index = 0; index < 3; index++) if (parts[index] !== minimum[index]) return parts[index]! > minimum[index]!;
  return true;
}

export async function readMihomoVersion(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.MIHOMO_BIN) candidates.push(process.env.MIHOMO_BIN);
  else if (process.platform === "win32") {
    for (const location of await discoverWindowsClashVergeInstallLocations()) {
      candidates.push(path.join(path.extname(location).toLowerCase() === ".exe" ? path.dirname(location) : location, "verge-mihomo.exe"));
    }
  } else if (process.platform === "darwin") candidates.push("/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo");
  if (!process.env.MIHOMO_BIN) candidates.push("mihomo");
  // Multiple installations are ambiguous: select one explicitly with MIHOMO_BIN.
  const versions = new Set<string>();
  let unverified = false;
  for (const binary of new Set(candidates)) {
    try {
      const { stdout } = await run(binary, ["-v"], { windowsHide: true, timeout: 3000, maxBuffer: 16384 });
      const version = stdout.match(/Mihomo\s+Meta\s+v(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
      if (version) versions.add(version);
      else unverified = true;
    } catch { /* An absent binary is not a verified kernel. */ }
  }
  return !unverified && versions.size === 1 ? [...versions][0]! : null;
}
