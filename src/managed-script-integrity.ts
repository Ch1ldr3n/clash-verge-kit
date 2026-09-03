import { generateClashVergeScript } from "./generator.ts";
import { parseManagedScript } from "./script-import.ts";

const MANAGEMENT_START = /^\/\* CLASH_VERGE_KIT_MANAGEMENT_V\d+$/;
const MANAGEMENT_END = /^CLASH_VERGE_KIT_MANAGEMENT_END \*\/$/;
const HISTORICAL_MULTILINE_FUNCTIONS = [
  "clonePlain(value)",
  "escapeRegex(value)",
  "groupUsesProvider(group, providerKey)",
] as const;

function restoreHistoricalLineBoundaries(lines: string[]): string[] {
  // The b50f5dd compactor packed these functions from their original
  // multiline form. Restore those boundaries to reproduce that shipped form.
  return lines.flatMap((line) => {
    for (const signature of HISTORICAL_MULTILINE_FUNCTIONS) {
      const prefix = `function ${signature} { `;
      if (line.startsWith(prefix) && line.endsWith(" }")) {
        return [prefix.trimEnd(), line.slice(prefix.length, -2), "}"];
      }
    }
    return [line];
  });
}

function compactHistoricalManagedScript(script: string): string | null {
  const lines = restoreHistoricalLineBoundaries(script.replace(/\r\n/g, "\n").split("\n"));
  const start = lines.findIndex((line) => MANAGEMENT_START.test(line));
  const end = lines.findIndex((line, index) => index > start && MANAGEMENT_END.test(line));
  if (start < 0 || end < 0) return null;

  const runtime: string[] = [];
  let insideBlockComment = false;
  for (const line of [...lines.slice(0, start), ...lines.slice(end + 1)]) {
    const trimmed = line.trim();
    if (insideBlockComment) {
      if (trimmed.endsWith("*/")) insideBlockComment = false;
      continue;
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.endsWith("*/")) insideBlockComment = true;
      continue;
    }
    runtime.push(trimmed);
  }
  if (!runtime.length) return null;

  const packed: string[] = [];
  let current = "";
  for (const line of runtime) {
    if (!current) current = line;
    else if (current.length + line.length + 1 <= 160) current += ` ${line}`;
    else {
      packed.push(current);
      current = line;
    }
  }
  if (current) packed.push(current);
  return `${lines.slice(start, end + 1).join("\n")}\n${packed.join("\n")}`;
}

export type ManagedScriptAuthenticity = "current-readable" | "historical-compact" | "invalid";

export function classifyManagedScript(script: string): ManagedScriptAuthenticity {
  const imported = parseManagedScript(script);
  if (!imported.ok) return "invalid";
  const generated = generateClashVergeScript(imported.spec);
  if (!generated.valid) return "invalid";
  if (script === generated.fullScript) return "current-readable";
  return script === compactHistoricalManagedScript(generated.fullScript)
    ? "historical-compact"
    : "invalid";
}
