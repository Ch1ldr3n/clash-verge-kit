import { describe, expect, it } from "vitest";
import { extractPackageArchiveName, extractPackageFiles } from "../scripts/npm-pack-report.mjs";

const expectedFiles = [
  "LICENSE",
  "README.en.md",
  "README.md",
  "dist/cli/cli.mjs",
  "package.json",
];
const packageReport = { files: expectedFiles.map((file) => ({ path: file })) };

describe("npm package report parsing", () => {
  it("accepts the legacy array-shaped npm pack report", () => {
    expect(extractPackageFiles([packageReport])).toEqual(expectedFiles);
  });

  it("accepts the npm 11 report keyed by package name", () => {
    expect(extractPackageFiles({ "clash-verge-kit": packageReport })).toEqual(expectedFiles);
  });

  it("extracts the archive name from the npm 11 report", () => {
    expect(extractPackageArchiveName({
      "clash-verge-kit": { ...packageReport, filename: "clash-verge-kit-1.0.0.tgz" },
    })).toBe("clash-verge-kit-1.0.0.tgz");
  });

  it("rejects ambiguous reports containing multiple packages", () => {
    expect(() => extractPackageFiles({ first: packageReport, second: packageReport })).toThrow(
      "exactly one package",
    );
  });
});
