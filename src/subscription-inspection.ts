export interface LocalProfileCatalogItem {
  id: string;
  name: string;
  status: "available";
  isCurrent?: true;
}

export interface LocalProfileSelection {
  profileId: string;
  name: string;
  source: string;
  inspection: SubscriptionInspectionSummary;
}

export type SubscriptionInspectionOrigin = "local" | "remote";
export type SubscriptionInspectionStatus = "available" | "warning";
export type SubscriptionFormat = "clash-yaml" | "unknown";
export type SubscriptionNameSource =
  | "local"
  | "profile-title"
  | "yaml"
  | "filename"
  | "group"
  | null;

export interface SubscriptionInspectionSummary {
  status: SubscriptionInspectionStatus;
  name: string | null;
  nameSource: SubscriptionNameSource;
  origin: SubscriptionInspectionOrigin;
  format: SubscriptionFormat;
  selectGroups: string[];
  suggestedGroup: string | null;
  nodeCount: number | null;
  warnings: string[];
}

type InspectionSummaryInput = Omit<SubscriptionInspectionSummary, "status">;

export function createSubscriptionInspectionSummary(
  input: InspectionSummaryInput,
): SubscriptionInspectionSummary {
  return {
    status: input.warnings.length > 0 ? "warning" : "available",
    name: input.name,
    nameSource: input.nameSource,
    origin: input.origin,
    format: input.format,
    selectGroups: input.selectGroups,
    suggestedGroup: input.suggestedGroup,
    nodeCount: input.nodeCount,
    warnings: input.warnings,
  };
}
