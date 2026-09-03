import type { GenerationResult, GeneratorSpec } from "./types";

export interface WorkspaceSessionState {
  draft: GeneratorSpec;
  generation: GenerationResult;
}

function cloneGeneratorSpec(spec: GeneratorSpec): GeneratorSpec {
  return {
    targetProfile: { ...spec.targetProfile },
    parentGroupMode: spec.parentGroupMode,
    parentGroupName: spec.parentGroupName,
    children: spec.children.map((child) => ({ ...child })),
    removedChildren: spec.removedChildren?.map((child) => ({ ...child })),
    ai: { ...spec.ai, customDomains: [...spec.ai.customDomains] },
  };
}

export function createWorkspaceSession(
  draft: GeneratorSpec,
  generate: (spec: GeneratorSpec) => GenerationResult,
): WorkspaceSessionState {
  const nextDraft = cloneGeneratorSpec(draft);
  return {
    draft: nextDraft,
    generation: generate(nextDraft),
  };
}

export function updateWorkspaceSession(
  state: WorkspaceSessionState,
  update: (draft: GeneratorSpec) => GeneratorSpec,
  generate: (spec: GeneratorSpec) => GenerationResult,
): WorkspaceSessionState {
  return createWorkspaceSession(update(cloneGeneratorSpec(state.draft)), generate);
}
