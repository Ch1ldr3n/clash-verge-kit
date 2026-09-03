import { describe, expect, it } from "vitest";
import { findProfileNameInYaml, normalizeProfileSource } from "../scripts/local-profile-repository";
import {
  cleanProfileName,
  extractSelectGroupsFromYaml,
  inspectProfileYaml,
  MAX_SELECT_GROUPS,
} from "../scripts/profile-yaml";

describe("local Clash Verge profile parsing", () => {
  const profilesYaml = `
items:
  - name: Test profile
    type: remote
    url: https://dasho.example.test/sub?token=example&client=clash
  - name: Local only
    type: local
    file: local.yaml
`;

  it("matches an exact subscription source without returning the stored URL", () => {
    expect(findProfileNameInYaml(
      profilesYaml,
      "https://dasho.example.test/sub?client=clash&token=example#ignored",
    )).toBe("Test profile");
  });

  it("does not match a different token or a malformed source", () => {
    expect(findProfileNameInYaml(profilesYaml, "https://dasho.example.test/sub?token=other")).toBeNull();
    expect(findProfileNameInYaml(profilesYaml, "not-a-url")).toBeNull();
  });

  it("normalizes query order and removes fragments", () => {
    expect(normalizeProfileSource("https://example.test/sub?b=2&a=1#x"))
      .toBe("https://example.test/sub?a=1&b=2");
  });

  it("extracts a safe profile name during the shared YAML inspection", () => {
    const maximumName = "x".repeat(128);
    expect(inspectProfileYaml("name: Example.yaml\nproxies: []\n").profileName).toBe("Example");
    expect(inspectProfileYaml(`name: ${maximumName}.yaml\nproxies: []\n`).profileName).toBe(maximumName);
    expect(inspectProfileYaml("name: \"Main\\u202eexe.js\"\nproxies: []\n").profileName).toBeNull();
  });

  it("lists select groups without recommending a terminal MATCH target among multiple candidates", () => {
    expect(extractSelectGroupsFromYaml(`
proxy-groups:
  - name: Main
    type: select
  - name: AI
    type: select
  - name: Auto
    type: url-test
rules:
  - MATCH,Main
    `)).toEqual({
      selectGroups: ["Main", "AI"],
      suggestedGroup: null,
    });
  });

  it.each(["MATCH", "FINAL"] as const)(
    "caps displayed groups without losing a terminal %s target beyond the cap",
    (terminalRule) => {
      const terminalGroup = `Group ${MAX_SELECT_GROUPS + 1}`;
      const proxyGroups = Array.from({ length: MAX_SELECT_GROUPS + 1 }, (_, index) => [
        `  - name: Group ${index + 1}`,
        "    type: select",
      ]).flat();
      const inspection = inspectProfileYaml([
        "proxy-groups:",
        ...proxyGroups,
        "rules:",
        `  - ${terminalRule},${terminalGroup}`,
      ].join("\n"));

      expect(inspection.selectGroups).toHaveLength(MAX_SELECT_GROUPS);
      expect(inspection.selectGroups.at(-1)).toBe(`Group ${MAX_SELECT_GROUPS}`);
      expect(inspection.warnings).toContain("select-groups-truncated");
      expect(inspection.suggestedGroup).toBeNull();
      expect(inspection.terminalGroup).toBe(terminalGroup);
    },
  );

  it("rejects terminal control and bidirectional formatting characters in names", () => {
    expect(cleanProfileName("家庭 👨‍👩‍👧‍👦")).toBe("家庭 👨‍👩‍👧‍👦");
    expect(cleanProfileName("unsafe\u001b]52;c;ZmFrZQ==\u0007")).toBeNull();
    expect(cleanProfileName("Main\u202eexe.js")).toBeNull();

    expect(extractSelectGroupsFromYaml(`
proxy-groups:
  - name: "\\u001b]52;c;ZmFrZQ==\\u0007"
    type: select
  - name: "Main\\u202eexe.js"
    type: select
  - name: Safe
    type: select
rules:
  - MATCH,Safe
`)).toEqual({
      selectGroups: ["Safe"],
      suggestedGroup: "Safe",
    });
  });
});
