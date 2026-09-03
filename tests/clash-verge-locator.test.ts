import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLASH_VERGE_APP_ID,
  discoverClashVergeProfileFiles,
  profileFileCandidatesFromUserInput,
} from "../scripts/clash-verge-locator";

describe("Clash Verge Rev profile location discovery", () => {
  it("combines the Windows AppData location with portable installs discovered on other drives", async () => {
    const candidates = await discoverClashVergeProfileFiles({
      platform: "win32",
      environment: { APPDATA: "C:\\Users\\Example\\AppData\\Roaming" },
      windowsInstallLocations: async () => [
        "D:\\Tools\\Clash Verge\\Clash Verge.exe",
        "F:\\Portable\\Clash Verge",
      ],
      pathExists: async () => true,
    });

    expect(candidates).toEqual([
      path.win32.resolve("C:\\Users\\Example\\AppData\\Roaming", CLASH_VERGE_APP_ID, "profiles.yaml"),
      path.win32.resolve("D:\\Tools\\Clash Verge", ".config", CLASH_VERGE_APP_ID, "profiles.yaml"),
      path.win32.resolve("F:\\Portable\\Clash Verge", ".config", CLASH_VERGE_APP_ID, "profiles.yaml"),
    ]);
  });

  it("does not mistake an ordinary installation on another drive for portable data", async () => {
    const candidates = await discoverClashVergeProfileFiles({
      platform: "win32",
      environment: { APPDATA: "C:\\Users\\Example\\AppData\\Roaming" },
      windowsInstallLocations: async () => ["D:\\Apps\\Clash Verge\\Clash Verge.exe"],
      pathExists: async () => false,
    });

    expect(candidates).toEqual([
      path.win32.resolve("C:\\Users\\Example\\AppData\\Roaming", CLASH_VERGE_APP_ID, "profiles.yaml"),
    ]);
  });

  it("honors XDG_DATA_HOME on Linux", async () => {
    const [candidate] = await discoverClashVergeProfileFiles({
      platform: "linux",
      environment: { XDG_DATA_HOME: "/mnt/config-data" },
      homeDirectory: "/home/example",
    });

    expect(candidate).toBe(path.posix.resolve("/mnt/config-data", CLASH_VERGE_APP_ID, "profiles.yaml"));
  });

  it("turns a manually entered data directory, install directory, or profiles file into bounded candidates", () => {
    expect(profileFileCandidatesFromUserInput("D:\\Portable\\Clash Verge", "win32")).toEqual([
      path.win32.resolve("D:\\Portable\\Clash Verge", "profiles.yaml"),
      path.win32.resolve("D:\\Portable\\Clash Verge", ".config", CLASH_VERGE_APP_ID, "profiles.yaml"),
      path.win32.resolve("D:\\Portable\\Clash Verge", CLASH_VERGE_APP_ID, "profiles.yaml"),
    ]);
    expect(profileFileCandidatesFromUserInput('"D:\\Data\\profiles.yaml"', "win32")).toEqual([
      path.win32.resolve("D:\\Data\\profiles.yaml"),
    ]);
  });
});
