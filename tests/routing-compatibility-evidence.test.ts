import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateClashVergeScript } from "../src/generator";
import { classifyManagedScript, inspectManagedScript } from "../src/managed-script-integrity";
import { normalizeManagedSpec, parseManagedScript } from "../src/script-import";
import type { GeneratorSpec } from "../src/types";

const baselineHashes = {
  disabled: "637ef4b965f0c94f8956f102aabb0b73ebef3db4f868e0e0038fab46c8957cbf",
  existing: "5ee6668d4ccdf145ef600fcecbc8a740a331ae8cb770200fa4c729fcdde416ff",
  create: "4f9b8cd5be413764bb6d3784bf67003e8f881a049fb0e8192153f0e2ad3447af",
} as const;

// Synthetic V1 evidence captured from 095a14d; never store generated scripts.
function fixture(mode: "disabled" | "existing" | "create"): GeneratorSpec {
  return {
    targetProfile: { name: "Main", source: "https://main.example.test/synthetic" },
    parentGroupMode: "manual",
    parentGroupName: "PROXY",
    children: [{ id: "child-1", groupName: "Nested", mode: "http", source: "https://child.example.test/synthetic" }],
    removedChildren: [],
    ai: { enabled: mode !== "disabled", mode: mode === "create" ? "create" : "existing", groupName: "AI", customDomains: ["synthetic.example.test"] },
  };
}

describe("Issue 1: V1 compatibility evidence (not V2 implementation)", () => {
  it.each(["disabled", "existing", "create"] as const)("preserves %s semantics and rejects modified runtime", (mode) => {
    const spec = fixture(mode);
    const generated = generateClashVergeScript(spec);
    expect(generated.valid).toBe(true);
    expect(createHash("sha256").update(generated.fullScript).digest("hex")).toBe(baselineHashes[mode]);
    expect(parseManagedScript(generated.fullScript)).toEqual({ ok: true, spec });
    expect(classifyManagedScript(generated.fullScript)).toBe("current-readable");
    expect(inspectManagedScript(generated.fullScript)).toEqual({ authenticity: "current-readable", parsedSpec: spec });
    const modified = `throw new Error("must never execute");\n${generated.fullScript}`;
    expect(parseManagedScript(modified)).toEqual({ ok: true, spec });
    expect(classifyManagedScript(modified)).toBe("invalid");
    expect(inspectManagedScript(modified)).toEqual({ authenticity: "invalid", parsedSpec: spec });
    expect(classifyManagedScript(`${generated.fullScript}\n// extra code boundary`)).toBe("invalid");
  });

  it("demonstrates why standalone routing requires a new format", () => {
    expect(normalizeManagedSpec({ ...fixture("existing"), children: [] })).toBeNull();
  });

  it("rejects unknown versions and duplicate management blocks", () => {
    const script = generateClashVergeScript(fixture("existing")).fullScript;
    const unknown = script.replace("CLASH_VERGE_KIT_MANAGEMENT_V1", "CLASH_VERGE_KIT_MANAGEMENT_V999");
    expect(parseManagedScript(unknown)).toMatchObject({ ok: false, error: { code: "version-unsupported" } });
    expect(classifyManagedScript(unknown)).toBe("invalid");
    expect(inspectManagedScript(unknown)).toEqual({ authenticity: "invalid", parsedSpec: null });
    expect(classifyManagedScript(`${script}\n${script}`)).toBe("invalid");
    expect(inspectManagedScript(`${script}\n${script}`)).toEqual({ authenticity: "invalid", parsedSpec: null });
  });
});
