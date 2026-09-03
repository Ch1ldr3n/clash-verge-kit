import { describe, expect, it } from "vitest";
import { generateClashVergeScript } from "../src/generator";
import { sha256Hex } from "../src/integrity";
import { parseManagedScript } from "../src/script-import";
import type { GeneratorSpec } from "../src/types";

function managedSpec(): GeneratorSpec {
  return {
    targetProfile: { name: "Main", source: "https://main.example.test/private-token" },
    parentGroupMode: "manual",
    parentGroupName: "PROXY",
    children: [{
      id: "child-1",
      groupName: "Nested",
      mode: "http",
      source: "https://nested.example.test/private-token",
    }],
    removedChildren: [],
    ai: { enabled: true, mode: "existing", groupName: "AI", customDomains: ["example.ai"] },
  };
}

describe("managed script import", () => {
  it("uses a standards-compatible SHA-256 checksum", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("你好")).toBe("670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e");
    expect(sha256Hex("a".repeat(100_000))).toBe("6d1cf22d7cc09b085dfc25ee1a1f3ae0265804c607bc2074ad253bcc82fd81ee");
  });

  it("restores a generated script without executing its JavaScript", () => {
    const generated = generateClashVergeScript(managedSpec());
    const maliciousWrapper = `throw new Error("must not execute");\n${generated.fullScript}`;
    const result = parseManagedScript(maliciousWrapper);

    expect(result).toEqual({ ok: true, spec: managedSpec() });
  });

  it("rejects a single-byte metadata change", () => {
    const generated = generateClashVergeScript(managedSpec());
    const match = generated.fullScript.match(/CLASH_VERGE_KIT_MANAGEMENT_V1\n([A-Za-z0-9_-]+)/);
    expect(match).not.toBeNull();
    const payload = match![1]!;
    const envelope = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      spec: { targetProfile: { name: string } };
    };
    envelope.spec.targetProfile.name = "Nain";
    const tamperedPayload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    const tampered = generated.fullScript.replace(payload, tamperedPayload);

    expect(parseManagedScript(tampered)).toMatchObject({ ok: false, error: { code: "integrity-mismatch" } });
  });

  it("rejects duplicate blocks, unknown versions, and oversized files", () => {
    const generated = generateClashVergeScript(managedSpec());
    const block = generated.fullScript.match(
      /\/\* CLASH_VERGE_KIT_MANAGEMENT_V1\n[A-Za-z0-9_-]+\nCLASH_VERGE_KIT_MANAGEMENT_END \*\//,
    )![0];
    expect(parseManagedScript(`${generated.fullScript}\n${block}`))
      .toMatchObject({ ok: false, error: { code: "metadata-duplicate" } });
    expect(parseManagedScript(
      `${generated.fullScript}\n/* CLASH_VERGE_KIT_MANAGEMENT_V1\nnot-valid!\nCLASH_VERGE_KIT_MANAGEMENT_END */`,
    )).toMatchObject({ ok: false, error: { code: "metadata-duplicate" } });
    expect(parseManagedScript(
      `${generated.fullScript}\n/* CLASH_VERGE_KIT_MANAGEMENT_V1 \nnot-valid!\nCLASH_VERGE_KIT_MANAGEMENT_END */`,
    )).toMatchObject({ ok: false, error: { code: "metadata-duplicate" } });
    expect(parseManagedScript("/* CLASH_VERGE_KIT_MANAGEMENT_V2\nAA\nCLASH_VERGE_KIT_MANAGEMENT_END */"))
      .toMatchObject({ ok: false, error: { code: "version-unsupported" } });
    expect(parseManagedScript("x".repeat(2 * 1024 * 1024 + 1)))
      .toMatchObject({ ok: false, error: { code: "file-too-large" } });
  });
});
