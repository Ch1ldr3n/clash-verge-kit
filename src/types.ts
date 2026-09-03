export type Language = "zh" | "en";
export type ProviderMode = "http" | "file";
export type ParentGroupMode = "auto" | "manual";

export interface ChildSubscription {
  id: string;
  groupName: string;
  groupNameManuallyEdited?: boolean;
  mode: ProviderMode;
  source: string;
  nodePrefix?: string;
}

export interface AiPreset {
  enabled: boolean;
  mode: "existing" | "create";
  groupName: string;
  customDomains: string[];
}

export interface TargetProfile {
  name: string;
  source: string;
}

export interface RemovedChildSubscription {
  groupName: string;
  nodePrefix: string;
  providerKey: string;
  legacyProviderKey: string;
  providerMode: ProviderMode;
  sourceHash: string;
}

export type GenerationOperation = "apply" | "update" | "restore";

export interface GeneratorSpec {
  targetProfile: TargetProfile;
  parentGroupMode: ParentGroupMode;
  parentGroupName: string;
  children: ChildSubscription[];
  removedChildren?: RemovedChildSubscription[];
  ai: AiPreset;
}

export type DiagnosticSeverity = "error" | "warning" | "success";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: {
    zh: string;
    en: string;
  };
  field?: string;
}

export interface TopologyChild {
  groupName: string;
  providerMode: ProviderMode;
  nodePrefix: string;
}

export interface TopologySummary {
  targetProfileName: string;
  parentGroupMode: ParentGroupMode;
  parentGroupName: string;
  children: TopologyChild[];
  removedChildren: string[];
  keptCount: number;
  removedCount: number;
  aiEnabled: boolean;
  aiGroupName?: string;
}

export interface GenerationResult {
  valid: boolean;
  operation: GenerationOperation;
  fullScript: string;
  maskedScript: string;
  diagnostics: Diagnostic[];
  topology: TopologySummary;
}
