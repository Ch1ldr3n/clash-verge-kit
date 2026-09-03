import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceSession,
  updateWorkspaceSession,
} from "../src/workspace-session";
import type { GenerationResult, GeneratorSpec } from "../src/types";

function createSpec(): GeneratorSpec {
  return {
    targetProfile: { name: "Main", source: "https://main.example.test/token" },
    parentGroupMode: "manual",
    parentGroupName: "PROXY",
    children: [{
      id: "child-1",
      groupName: "Child",
      mode: "http",
      source: "https://child.example.test/token",
    }],
    removedChildren: [],
    ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
  };
}

function createResult(groupName = "Child"): GenerationResult {
  return {
    valid: true,
    operation: "apply",
    fullScript: "return true;",
    maskedScript: "return true;",
    diagnostics: [],
    topology: {
      targetProfileName: "Main",
      parentGroupMode: "manual",
      parentGroupName: "PROXY",
      children: [{ groupName, providerMode: "http", nodePrefix: groupName }],
      removedChildren: [],
      keptCount: 1,
      removedCount: 0,
      aiEnabled: false,
    },
  };
}

describe("CLI workspace session", () => {
  it("clones the initial draft and immediately generates the matching result", () => {
    const source = createSpec();
    const generate = vi.fn((spec: GeneratorSpec) => createResult(spec.children[0]!.groupName));

    const session = createWorkspaceSession(source, generate);
    source.children[0]!.groupName = "Changed outside";

    expect(session.draft.children[0]!.groupName).toBe("Child");
    expect(session.generation.topology.children[0]!.groupName).toBe("Child");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("regenerates synchronously whenever the draft changes", () => {
    const generate = vi.fn((spec: GeneratorSpec) => createResult(spec.children[0]!.groupName));
    const session = createWorkspaceSession(createSpec(), generate);

    const next = updateWorkspaceSession(
      session,
      (draft) => ({
        ...draft,
        children: draft.children.map((child) => ({ ...child, groupName: "Renamed" })),
      }),
      generate,
    );

    expect(next.draft.children[0]!.groupName).toBe("Renamed");
    expect(next.generation.topology.children[0]!.groupName).toBe("Renamed");
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
