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
  ruleSource?: "services-v1";
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
  routing?: RoutingPlan;
}

export interface RoutingPlan {
  legacyAi?: {
    ruleSource: "services-v1" | "legacy-ai-v1";
    groupName: string;
    customDomains: string[];
  };
  sources: ({ id: string; kind: "target" } | RoutingSubscriptionSource)[];
  outlets: ({ id: string; kind: "existing"; groupName: string }
    | { id: string; kind: "selected"; groupName: string; nodes: RoutingNodeReference[] })[];
  modules: {
    id: string;
    kind: "ai";
    enabled: boolean;
    outletId: string;
    ruleSource: "category-ai-v1" | "services-v1" | "legacy-ai-v1";
    customDomains: string[];
  }[];
}

export interface RoutingNodeReference {
  sourceId: string;
  provider: string | null;
  name: string;
}

export interface RoutingSubscriptionSource {
  id: string;
  kind: "subscription";
  name: string;
  mode: ProviderMode;
  source: string;
  providers?: { id: string; mode: ProviderMode; source: string; interval: number }[];
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
  aiOutletKind?: "existing" | "selected";
}

export interface GenerationResult {
  valid: boolean;
  operation: GenerationOperation;
  fullScript: string;
  maskedScript: string;
  diagnostics: Diagnostic[];
  topology: TopologySummary;
}
