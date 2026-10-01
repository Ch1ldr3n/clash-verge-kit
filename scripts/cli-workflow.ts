import { BackRequestedError, type CliIO } from "./cli-io.ts";
import { getCliMessages } from "./cli-messages.ts";
import { normalizeProfileSource, type LocalProfileRepository } from "./local-profile-repository.ts";
import { cleanProfileName, MAX_SELECT_GROUPS } from "./profile-yaml.ts";
import type {
  LocalProfileCatalogItem,
  LocalProfileSelection,
  SubscriptionInspectionSummary,
} from "../src/subscription-inspection.ts";
import {
  createWorkspaceSession,
  updateWorkspaceSession,
  type WorkspaceSessionState,
} from "../src/workspace-session.ts";
import type { GenerationResult, GeneratorSpec, Language } from "../src/types.ts";
import { MAX_MANAGED_CHILDREN } from "../src/script-import.ts";
import { collectSelectedNodes, verifySelectedNodes } from "./cli-routing-nodes.ts";
import { editRoutingPlan } from "../src/routing-plan-editing.ts";

type CliMessages = ReturnType<typeof getCliMessages>;
type GroupMenuMessages = Pick<CliMessages,
  "parentGroupSelect" | "singleParentGroupSelected" | "parentGroupsTruncated"
> & Record<"noDetectedParentGroup" | "previousPage" | "nextPage" | "filterParentGroups"
  | "parentGroupFilter" | "noMatchingParentGroups", string>;

export interface CliWorkflowDependencies {
  entryMode?: "choose" | "ai";
  io: CliIO;
  profiles: LocalProfileRepository;
  inspectRemote(source: string): Promise<SubscriptionInspectionSummary>;
  generate(spec: GeneratorSpec): GenerationResult;
  copyScript(script: string): Promise<boolean>;
  createChildId(): string;
  mihomoVersion?(): Promise<string | null>;
}

export type CliExitReason = "completed";

interface CollectedTarget {
  profileId: string;
  name: string;
  source: string;
  inspection: SubscriptionInspectionSummary;
}

interface CollectedChild {
  spec: GeneratorSpec["children"][number];
  subscriptionName: string;
}

interface CollectedInitialSpec {
  spec: GeneratorSpec;
  catalog: LocalProfileCatalogItem[];
  targetProfileId: string;
  childSubscriptionNames: Map<string, string>;
  savedRevision?: string;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ICON_GRAPHEME = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{S}|[#*0-9]\uFE0F?\u20E3)/u;
const PARENT_GROUP_PAGE_SIZE = 10;

type ParentGroupMenuAction =
  | { type: "group"; group: string }
  | { type: "previous" }
  | { type: "next" }
  | { type: "filter" };

function formatGroupMenuLabel(name: string): string {
  const firstGrapheme = GRAPHEME_SEGMENTER.segment(name)[Symbol.iterator]().next().value?.segment;
  if (!firstGrapheme || !ICON_GRAPHEME.test(firstGrapheme)) return name;
  const rest = name.slice(firstGrapheme.length);
  return rest && !/^\s/u.test(rest) ? `${firstGrapheme} ${rest}` : name;
}

async function askRequired(io: CliIO, prompt: string, copy: CliMessages): Promise<string> {
  while (true) {
    const value = (await io.ask(prompt)).trim();
    if (value) return value;
    io.writeLine(copy.required);
  }
}

async function askHttpsUrl(io: CliIO, prompt: string, copy: CliMessages): Promise<string> {
  while (true) {
    const source = await askRequired(io, prompt, copy);
    try {
      const parsed = new URL(source);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return parsed.toString();
    } catch {
      // The localized validation message below is intentionally source-free.
    }
    io.writeLine(copy.invalidHttps);
  }
}

async function inspectWithConsent(
  dependencies: CliWorkflowDependencies,
  source: string,
  copy: CliMessages,
): Promise<SubscriptionInspectionSummary | null> {
  if (!await dependencies.io.confirm(copy.inspectUrl)) return null;
  try {
    return await dependencies.inspectRemote(source);
  } catch {
    dependencies.io.writeLine(copy.inspectionFailed);
    return null;
  }
}

async function chooseParentGroup(
  io: CliIO,
  inspection: SubscriptionInspectionSummary,
  copy: GroupMenuMessages,
  autoSelectSingle = true,
): Promise<Pick<GeneratorSpec, "parentGroupMode" | "parentGroupName">> {
  const detectedGroups = [...new Set(
    inspection.selectGroups
      .map((group) => cleanProfileName(group))
      .filter((group): group is string => Boolean(group)),
  )];

  if (!detectedGroups.length) {
    io.writeLine(copy.noDetectedParentGroup);
    throw new BackRequestedError();
  }
  if (detectedGroups.length === 1 && autoSelectSingle) {
    const group = detectedGroups[0]!;
    io.writeLine(copy.singleParentGroupSelected(group));
    return { parentGroupMode: "manual", parentGroupName: group };
  }

  if (inspection.warnings.includes("select-groups-truncated")) {
    io.writeLine(copy.parentGroupsTruncated(MAX_SELECT_GROUPS));
  }

  let filter = "";
  let pageIndex = 0;
  while (true) {
    const normalizedFilter = filter.toLocaleLowerCase();
    const filteredGroups = normalizedFilter
      ? detectedGroups.filter((group) => group.toLocaleLowerCase().includes(normalizedFilter))
      : detectedGroups;
    const pageCount = Math.max(1, Math.ceil(filteredGroups.length / PARENT_GROUP_PAGE_SIZE));
    pageIndex = Math.min(pageIndex, pageCount - 1);
    const pageGroups = filteredGroups.slice(
      pageIndex * PARENT_GROUP_PAGE_SIZE,
      (pageIndex + 1) * PARENT_GROUP_PAGE_SIZE,
    );
    const actions: ParentGroupMenuAction[] = [
      ...pageGroups.map((group) => ({ type: "group" as const, group })),
      ...(pageIndex > 0 ? [{ type: "previous" as const }] : []),
      ...(pageIndex < pageCount - 1 ? [{ type: "next" as const }] : []),
      ...(detectedGroups.length > PARENT_GROUP_PAGE_SIZE || filter
        ? [{ type: "filter" as const }]
        : []),
    ];
    const selected = await io.choose(
      copy.parentGroupSelect(
        detectedGroups.length,
        pageIndex + 1,
        pageCount,
        filter ? filteredGroups.length : null,
      ),
      actions.map((action) => {
        if (action.type === "group") {
          return formatGroupMenuLabel(action.group);
        }
        if (action.type === "previous") return copy.previousPage;
        if (action.type === "next") return copy.nextPage;
        return copy.filterParentGroups;
      }),
    );
    const action = actions[selected]!;
    if (action.type === "group") {
      return { parentGroupMode: "manual", parentGroupName: action.group };
    }
    if (action.type === "previous") {
      pageIndex -= 1;
      continue;
    }
    if (action.type === "next") {
      pageIndex += 1;
      continue;
    }
    if (action.type === "filter") {
      try {
        const nextFilter = (await io.ask(copy.parentGroupFilter)).trim();
        if (!nextFilter) {
          filter = "";
          pageIndex = 0;
          continue;
        }
        const normalizedNextFilter = nextFilter.toLocaleLowerCase();
        if (!detectedGroups.some((group) => group.toLocaleLowerCase().includes(normalizedNextFilter))) {
          io.writeLine(copy.noMatchingParentGroups);
          continue;
        }
        filter = nextFilter;
        pageIndex = 0;
      } catch (error) {
        if (!(error instanceof BackRequestedError)) throw error;
      }
      continue;
    }
  }
}

async function collectTarget(
  dependencies: CliWorkflowDependencies,
  catalog: LocalProfileCatalogItem[],
  copy: CliMessages,
): Promise<CollectedTarget> {
  const current = catalog.find((profile) => profile.isCurrent);
  const orderedCatalog = current
    ? [current, ...catalog.filter((profile) => profile.id !== current.id)]
    : [...catalog];
  while (true) {
    const selected = await dependencies.io.choose(
      copy.targetSelect,
      orderedCatalog.map((profile) => profile.isCurrent
        ? copy.currentTargetOption(profile.name)
        : profile.name),
      copy.exit,
    );
    const profile = await dependencies.profiles.select(orderedCatalog[selected]!.id);
    if (profile) {
      return {
        profileId: profile.profileId,
        name: profile.name,
        source: profile.source,
        inspection: profile.inspection,
      };
    }
    dependencies.io.writeLine(copy.noLocalProfiles);
  }
}

async function askRequiredName(io: CliIO, prompt: string, copy: CliMessages): Promise<string> {
  while (true) {
    const name = cleanProfileName(await io.ask(prompt));
    if (name) return name;
    io.writeLine(copy.invalidName);
  }
}

async function askOptionalName(
  io: CliIO,
  prompt: string,
  fallback: string,
  copy: CliMessages,
): Promise<string> {
  while (true) {
    const value = await io.ask(prompt);
    if (!value.trim()) return fallback;
    const name = cleanProfileName(value);
    if (name) return name;
    io.writeLine(copy.invalidName);
  }
}

async function collectManualChild(
  dependencies: CliWorkflowDependencies,
  copy: CliMessages,
): Promise<LocalProfileSelection> {
  sourceLoop: while (true) {
    const source = await askHttpsUrl(dependencies.io, copy.childUrl, copy);
    while (true) {
      let inspection: SubscriptionInspectionSummary | null;
      try {
        inspection = await inspectWithConsent(dependencies, source, copy);
      } catch (error) {
        if (error instanceof BackRequestedError) continue sourceLoop;
        throw error;
      }
      let name: string;
      const inspectedName = cleanProfileName(inspection?.name);
      if (inspectedName) {
        name = inspectedName;
      } else {
        try {
          name = await askRequiredName(dependencies.io, copy.childName, copy);
        } catch (error) {
          if (error instanceof BackRequestedError) continue;
          throw error;
        }
      }
      return {
        profileId: "",
        name,
        source,
        inspection: inspection ?? {
          status: "warning",
          name,
          nameSource: null,
          origin: "remote",
          format: "unknown",
          selectGroups: [],
          suggestedGroup: null,
          nodeCount: null,
          warnings: ["not-inspected"],
        },
      };
    }
  }
}

async function collectChild(
  dependencies: CliWorkflowDependencies,
  catalog: LocalProfileCatalogItem[],
  targetProfileId: string,
  usedSources: Set<string>,
  copy: CliMessages,
): Promise<CollectedChild> {
  while (true) {
    const eligible = catalog.filter((profile) => profile.id !== targetProfileId);
    let selection: LocalProfileSelection | null = null;
    if (eligible.length) {
      const selected = await dependencies.io.choose(
        copy.childSelect,
        [...eligible.map((profile) => profile.name), copy.manual],
      );
      if (selected < eligible.length) {
        selection = await dependencies.profiles.select(eligible[selected]!.id);
      } else {
        try {
          selection = await collectManualChild(dependencies, copy);
        } catch (error) {
          if (error instanceof BackRequestedError) continue;
          throw error;
        }
      }
    } else {
      dependencies.io.writeLine(copy.noLocalProfiles);
      selection = await collectManualChild(dependencies, copy);
    }
    if (!selection) continue;
    const subscriptionName = cleanProfileName(selection.name);
    if (!subscriptionName) {
      dependencies.io.writeLine(copy.invalidName);
      continue;
    }
    const identity = normalizeProfileSource(selection.source) ?? selection.source.trim();
    if (usedSources.has(identity)) {
      dependencies.io.writeLine(copy.duplicateSource);
      continue;
    }
    return {
      subscriptionName,
      spec: {
        id: dependencies.createChildId(),
        groupName: subscriptionName,
        groupNameManuallyEdited: false,
        mode: "http",
        source: selection.source,
      },
    };
  }
}

async function collectInitialSpec(
  dependencies: CliWorkflowDependencies,
  copy: CliMessages,
  routingOnly = false,
): Promise<CollectedInitialSpec | null> {
  collectionLoop: while (true) {
    let catalog = await dependencies.profiles.list();
    while (!catalog.length && dependencies.profiles.addProfileLocation) {
      await dependencies.io.choose(copy.noLocalProfileAction, [copy.locateProfileDirectory]);
      let location: string;
      try {
        location = await askRequired(dependencies.io, copy.profileDirectoryPath, copy);
      } catch (error) {
        if (error instanceof BackRequestedError) continue;
        throw error;
      }
      const loaded = await dependencies.profiles.addProfileLocation(location);
      if (loaded.status === "loaded") {
        dependencies.io.writeLine(copy.profileDirectoryLoaded(loaded.profileCount));
        catalog = await dependencies.profiles.list();
      } else {
        dependencies.io.writeLine(copy.profileDirectoryNotFound);
      }
    }
    if (!catalog.length) {
      dependencies.io.writeLine(copy.noLocalTargetProfiles);
      throw new BackRequestedError();
    }
    targetLoop: while (true) {
      let target: CollectedTarget;
      try {
        target = await collectTarget(dependencies, catalog, copy);
      } catch (error) {
        if (error instanceof BackRequestedError) return null;
        throw error;
      }
      if (routingOnly) {
        const saved = await dependencies.profiles.readManagedPlan?.(target.profileId);
        if (saved && saved.status !== "none" && saved.status !== "saved") {
          dependencies.io.writeLine(saved.status === "read-only" ? copy.savedReadOnly : copy.savedReadFailed);
          continue targetLoop;
        }
        if (saved?.status === "saved") {
          let restored = editRoutingPlan(saved.spec, { kind: "open-saved" });
          if (!restored.routing) {
            try {
              const configured = await collectAiRouting(dependencies, restored, target.profileId, copy, true);
              if (!configured) continue targetLoop;
              restored = configured;
            } catch (error) {
              if (error instanceof BackRequestedError) continue targetLoop;
              throw error;
            }
          } else dependencies.io.writeLine(copy.savedLoaded);
          return { spec: restored, catalog, targetProfileId: target.profileId, savedRevision: saved.revision,
            childSubscriptionNames: new Map(restored.children.map(child => [child.id, child.groupName])) };
        }
        const spec: GeneratorSpec = {
          targetProfile: { name: target.name, source: target.source },
          parentGroupMode: "auto", parentGroupName: "", children: [], removedChildren: [],
          ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [], ruleSource: "services-v1" },
        };
        try {
          const routing = await collectAiRouting(dependencies, spec, target.profileId, copy, true);
          if (!routing) continue targetLoop;
          return { spec: routing, catalog, targetProfileId: target.profileId, childSubscriptionNames: new Map(), savedRevision: saved?.revision };
        } catch (error) {
          if (error instanceof BackRequestedError) continue targetLoop;
          throw error;
        }
      }
      while (true) {
        let parent: Pick<GeneratorSpec, "parentGroupMode" | "parentGroupName">;
        try {
          parent = await chooseParentGroup(dependencies.io, target.inspection, copy);
        } catch (error) {
          if (error instanceof BackRequestedError) {
            continue targetLoop;
          }
          throw error;
        }
        const targetIdentity = normalizeProfileSource(target.source) ?? target.source.trim();
        let child: CollectedChild;
        try {
          child = await collectChild(dependencies, catalog, target.profileId, new Set([targetIdentity]), copy);
        } catch (error) {
          if (error instanceof BackRequestedError) continue;
          throw error;
        }
        const spec: GeneratorSpec = {
          targetProfile: { name: target.name, source: target.source },
          ...parent,
          children: [child.spec],
          removedChildren: [],
          ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
        };
        return {
          spec,
          catalog,
          targetProfileId: target.profileId,
          childSubscriptionNames: new Map([[child.spec.id, child.subscriptionName]]),
        };
      }
    }
  }
}

function showGenerationSummary(
  io: CliIO,
  result: GenerationResult,
  language: Language,
  copy: CliMessages,
): void {
  io.writeLine(result.topology.children.length === 0 && result.topology.aiEnabled
    ? copy.aiGeneratedSummary(result.topology.targetProfileName)
    : copy.generatedSummary(
    result.topology.targetProfileName,
    result.topology.parentGroupName,
    result.topology.children.length,
  ));
  if (result.topology.aiEnabled && result.topology.aiGroupName) {
    io.writeLine(copy.aiSummary(result.topology.aiGroupName, result.topology.aiOutletKind === "selected"));
  }
  result.diagnostics
    .filter((diagnostic) => diagnostic.severity !== "success")
    .forEach((diagnostic) => io.writeLine(`[${diagnostic.severity}] ${diagnostic.message[language]}`));
}

function showGenerationDetails(
  io: CliIO,
  result: GenerationResult,
  language: Language,
  copy: CliMessages,
): void {
  io.writeLine(copy.topology);
  io.writeLine(result.topology.aiEnabled && !result.topology.children.length
    ? `${result.topology.targetProfileName}：${copy.aiSummary(result.topology.aiGroupName!, result.topology.aiOutletKind === "selected")}`
    : `${result.topology.targetProfileName} → ${result.topology.parentGroupName}`);
  result.topology.children.forEach((child) => io.writeLine(`- ${child.groupName}`));
  io.writeLine(copy.diagnostics);
  result.diagnostics.forEach((diagnostic) => io.writeLine(`[${diagnostic.severity}] ${diagnostic.message[language]}`));
}

function updateLatestChildGroup(
  session: WorkspaceSessionState,
  enteredGroupName: string,
  generate: CliWorkflowDependencies["generate"],
): WorkspaceSessionState {
  const lastIndex = session.draft.children.length - 1;
  const current = session.draft.children[lastIndex]!;
  const groupName = enteredGroupName.trim() || current.groupName;
  return updateWorkspaceSession(
    session,
    (draft) => ({
      ...draft,
      children: draft.children.map((child, index) => index === lastIndex
        ? { ...child, groupName, groupNameManuallyEdited: Boolean(enteredGroupName.trim()) }
        : child),
    }),
    generate,
  );
}

function childDirections(
  session: WorkspaceSessionState,
  childSubscriptionNames: ReadonlyMap<string, string>,
) {
  return session.draft.children.map((child) => ({
    subscriptionName: childSubscriptionNames.get(child.id) ?? child.groupName,
    groupName: child.groupName,
  }));
}

type DeliveryResult = "stay" | "restart" | "completed";

async function showCompletion(
  io: CliIO,
  message: string,
  copy: CliMessages,
): Promise<Exclude<DeliveryResult, "stay">> {
  try {
    await io.choose(message, [copy.reconfigure], copy.finishAndExit);
    return "restart";
  } catch (error) {
    if (error instanceof BackRequestedError) return "completed";
    throw error;
  }
}

async function exportCurrentScript(
  dependencies: CliWorkflowDependencies,
  session: WorkspaceSessionState,
  copy: CliMessages,
): Promise<DeliveryResult> {
  const copied = await dependencies.copyScript(session.generation!.fullScript);
  if (!copied) {
    dependencies.io.writeLine(copy.clipboardFailed);
    return "stay";
  }
  return showCompletion(dependencies.io, copy.copyCompleted, copy);
}

async function installCurrentScript(
  dependencies: CliWorkflowDependencies,
  session: WorkspaceSessionState,
  targetProfileId: string,
  copy: CliMessages,
  savedRevision?: string,
): Promise<DeliveryResult> {
  const result = await dependencies.profiles.installManagedScript(
    targetProfileId,
    session.generation!.fullScript,
    ...(savedRevision ? [savedRevision] : []),
  );
  if (result.status === "written") {
    return showCompletion(dependencies.io, copy.writeCompleted(result.targetIsCurrent), copy);
  }
  if (result.status === "target-missing") {
    dependencies.io.writeLine(copy.writeTargetMissing);
    return "restart";
  }
  if (result.status === "concurrent-change") {
    dependencies.io.writeLine(copy.writeChanged);
    return "restart";
  }
  if (result.status === "nesting-conflict") dependencies.io.writeLine(copy.writeNestingConflict);
  else if (result.status === "script-not-linked") dependencies.io.writeLine(copy.writeNotLinked);
  else if (result.status === "custom-script-conflict") dependencies.io.writeLine(copy.writeConflict);
  else dependencies.io.writeLine(copy.writeFailed);
  return "stay";
}

async function inspectAiTarget(
  dependencies: CliWorkflowDependencies,
  draft: GeneratorSpec,
  targetProfileId: string,
  copy: CliMessages,
): Promise<SubscriptionInspectionSummary | null> {
  let target: LocalProfileSelection | null;
  try {
    target = await dependencies.profiles.select(targetProfileId);
  } catch {
    dependencies.io.writeLine(copy.aiUnavailable);
    return null;
  }
  if (!target || target.name !== draft.targetProfile.name
    || normalizeProfileSource(target.source) !== normalizeProfileSource(draft.targetProfile.source)
    || target.inspection.format !== "clash-yaml") {
    dependencies.io.writeLine(copy.aiUnavailable);
    return null;
  }
  return {
    ...target.inspection,
    selectGroups: [...new Set([...target.inspection.selectGroups, ...draft.children.map(child => child.groupName)])]
      .filter((name) => !name.includes(",")),
  };
}

async function collectAiRouting(
  dependencies: CliWorkflowDependencies,
  draft: GeneratorSpec,
  targetProfileId: string,
  copy: CliMessages,
  chooseOnly = false,
): Promise<GeneratorSpec | null> {
  const actions = [
    { kind: "existing", label: copy.aiChooseExisting },
    ...(!chooseOnly ? [{ kind: "disable", label: copy.aiDisable }] as const : []),
    ...(!chooseOnly || dependencies.profiles.readRoutingSnapshot
      ? [{ kind: "selected", label: copy.aiSelectNodes }] as const : []),
  ] as const;
  while (true) {
    const action = actions[actions.length === 1 ? 0
      : await dependencies.io.choose(copy.aiAction, actions.map(action => action.label))]!.kind;
    if (action === "selected") {
      try { return await collectSelectedNodes(dependencies, draft, targetProfileId, copy); }
      catch (error) { if (error instanceof BackRequestedError) continue; throw error; }
    }
    if (action === "disable") return editRoutingPlan(draft, { kind: "disable" });
    const inspection = await inspectAiTarget(dependencies, draft, targetProfileId, copy);
    if (!inspection) return null;
    while (true) {
      let selected: Pick<GeneratorSpec, "parentGroupMode" | "parentGroupName">;
      try {
        selected = await chooseParentGroup(dependencies.io, inspection, {
          ...copy,
          parentGroupSelect: copy.aiGroupSelect,
          parentGroupFilter: copy.aiGroupFilter,
          noMatchingParentGroups: copy.aiNoMatchingGroups,
          noDetectedParentGroup: copy.aiUnavailable,
          parentGroupsTruncated: copy.aiGroupsTruncated,
        }, false);
      } catch (error) {
        if (error instanceof BackRequestedError) {
          if (chooseOnly && !dependencies.profiles.readRoutingSnapshot) throw error;
          break;
        }
        throw error;
      }
      try {
        if (!await dependencies.io.confirm(copy.aiConsent(selected.parentGroupName))) return null;
      } catch (error) {
        if (error instanceof BackRequestedError) continue;
        throw error;
      }
      return editRoutingPlan(draft, { kind: "use-existing", groupName: selected.parentGroupName });
    }
  }
}

async function verifyAiOutlet(
  dependencies: CliWorkflowDependencies,
  draft: GeneratorSpec,
  targetProfileId: string,
  copy: CliMessages,
): Promise<boolean> {
  const active = draft.routing?.modules.find(module => module.enabled);
  if (!active && !draft.ai.enabled) return true;
  const outlet = active && draft.routing!.outlets.find(outlet => outlet.id === active.outletId);
  if (outlet && outlet.kind === "selected") {
    return verifySelectedNodes(dependencies, draft, targetProfileId, copy);
  }
  const groupName = active ? outlet?.groupName : draft.ai.groupName;
  const inspection = await inspectAiTarget(dependencies, draft, targetProfileId, copy);
  if (!inspection) return false;
  if (!groupName || !inspection.selectGroups.includes(groupName)) {
    dependencies.io.writeLine(copy.aiUnavailable);
    return false;
  }
  return true;
}

async function reviewAndDeliver(
  dependencies: CliWorkflowDependencies,
  session: WorkspaceSessionState,
  targetProfileId: string,
  childSubscriptionNames: ReadonlyMap<string, string>,
  copy: CliMessages,
  savedRevision?: string,
): Promise<DeliveryResult> {
  if (!await verifyAiOutlet(dependencies, session.draft, targetProfileId, copy)) return "stay";
  if (session.generation.topology.aiEnabled) {
    dependencies.io.writeLine(copy.aiSummary(session.generation.topology.aiGroupName!, session.generation.topology.aiOutletKind === "selected"));
    dependencies.io.writeLine(copy.aiActivationCheck);
  }
  const actions = ["write", "copy", "restart"] as const;
  let selected: number;
  try {
    selected = await dependencies.io.choose(
      session.generation.topology.aiEnabled && !session.draft.children.length
        ? copy.aiDeliveryReview(session.draft.targetProfile.name, session.generation.topology.aiGroupName!)
        : copy.deliveryReview(
        session.generation.topology.targetProfileName,
        session.generation.topology.parentGroupName,
        childDirections(session, childSubscriptionNames),
      ),
      [copy.directionWriteCorrect, copy.directionCopyCorrect, copy.directionReversed],
    );
  } catch (error) {
    if (error instanceof BackRequestedError) return "stay";
    throw error;
  }
  const action = actions[selected]!;
  if (action === "restart") return "restart";
  if (!await verifyAiOutlet(dependencies, session.draft, targetProfileId, copy)) return "stay";
  if (action === "write") return installCurrentScript(dependencies, session, targetProfileId, copy, savedRevision);
  return exportCurrentScript(dependencies, session, copy);
}

export async function runCliWorkflow(dependencies: CliWorkflowDependencies): Promise<CliExitReason> {
  languageLoop: while (true) {
    let language: Language;
    try {
      language = await dependencies.io.choose(
        "请选择语言 / Choose language",
        ["中文", "English"],
        "退出 / Exit",
      ) === 0 ? "zh" : "en";
    } catch (error) {
      if (error instanceof BackRequestedError) {
        return "completed";
      }
      throw error;
    }
    const copy = getCliMessages(language);
    dependencies.io.setLanguage(language);
    dependencies.io.writeLine(copy.title);
    dependencies.io.writeLine(copy.privacy);
    let routingOnly = dependencies.entryMode === "ai";
    if (dependencies.entryMode === "choose") {
      try {
        routingOnly = await dependencies.io.choose(copy.featureSelect, [copy.nestingFeature, copy.aiFeature], copy.exit) === 1;
      } catch (error) {
        if (error instanceof BackRequestedError) return "completed";
        throw error;
      }
    }

    while (true) {
      let collected: Awaited<ReturnType<typeof collectInitialSpec>>;
      try {
        collected = await collectInitialSpec(dependencies, copy, routingOnly);
      } catch (error) {
        if (error instanceof BackRequestedError) continue languageLoop;
        throw error;
      }
    if (!collected) return "completed";
    let session = createWorkspaceSession(collected.spec, dependencies.generate);
    showGenerationSummary(dependencies.io, session.generation, language, copy);

    while (true) {
      if (!session.generation.valid) {
        dependencies.io.writeLine(copy.invalidResult);
        let invalidAction: number;
        try {
          invalidAction = await dependencies.io.choose(copy.previewAction, [copy.restart], copy.exit);
        } catch (error) {
          if (error instanceof BackRequestedError) return "completed";
          throw error;
        }
        if (invalidAction === 0) break;
      }

      const actions = [
        { kind: "deliver", label: copy.reviewAndDeliver },
        ...(!routingOnly ? [
          { kind: "add-child", label: copy.addChild },
          { kind: "rename-child", label: copy.renameChild },
        ] as const : []),
        { kind: "details", label: copy.showDetails },
        { kind: "preview", label: copy.showMaskedScript },
        { kind: "restart", label: copy.restart },
        { kind: "routing", label: copy.aiRouting },
      ] as const;
      let action: typeof actions[number]["kind"];
      try {
        const selectedAction = await dependencies.io.choose(
          copy.previewAction,
          actions.map(action => action.label),
          copy.exit,
        );
        action = actions[selectedAction]!.kind;
      } catch (error) {
        if (error instanceof BackRequestedError) return "completed";
        throw error;
      }
      if (action === "deliver") {
        const deliveryResult = await reviewAndDeliver(
          dependencies,
          session,
          collected.targetProfileId,
          collected.childSubscriptionNames,
          copy,
          collected.savedRevision,
        );
        if (deliveryResult === "completed") return "completed";
        if (deliveryResult === "restart") break;
        continue;
      }

      if (action === "add-child") {
        if (session.draft.children.length >= MAX_MANAGED_CHILDREN) {
          dependencies.io.writeLine(copy.childLimitReached(MAX_MANAGED_CHILDREN));
          continue;
        }
        const usedSources = new Set([
          session.draft.targetProfile.source,
          ...session.draft.children.map((child) => child.source),
        ].map((source) => normalizeProfileSource(source) ?? source.trim()));
        let child: CollectedChild;
        try {
          child = await collectChild(
            dependencies,
            collected.catalog,
            collected.targetProfileId,
            usedSources,
            copy,
          );
        } catch (error) {
          if (error instanceof BackRequestedError) continue;
          throw error;
        }
        collected.childSubscriptionNames.set(child.spec.id, child.subscriptionName);
        session = updateWorkspaceSession(
          session,
          (current) => ({ ...current, children: [...current.children, child.spec] }),
          dependencies.generate,
        );
        showGenerationSummary(dependencies.io, session.generation, language, copy);
        continue;
      }
      if (action === "rename-child") {
        try {
          const last = session.draft.children.at(-1)!;
          session = updateLatestChildGroup(
            session,
            await askOptionalName(dependencies.io, copy.childGroupName(last.groupName), last.groupName, copy),
            dependencies.generate,
          );
          showGenerationSummary(dependencies.io, session.generation, language, copy);
        } catch (error) {
          if (!(error instanceof BackRequestedError)) throw error;
        }
        continue;
      }
      if (action === "details") {
        showGenerationDetails(dependencies.io, session.generation, language, copy);
        continue;
      }
      if (action === "preview") {
        dependencies.io.writeLine(copy.maskedPreview);
        dependencies.io.writeLine(session.generation.maskedScript);
        continue;
      }
      if (action === "routing") {
        try {
          const nextAi = await collectAiRouting(dependencies, session.draft, collected.targetProfileId, copy);
          if (nextAi) {
            session = updateWorkspaceSession(session, () => nextAi, dependencies.generate);
            showGenerationSummary(dependencies.io, session.generation, language, copy);
            if (!session.generation.topology.aiEnabled) dependencies.io.writeLine(copy.aiDisabled);
          }
        } catch (error) {
          if (!(error instanceof BackRequestedError)) throw error;
        }
        continue;
      }
      break;
    }
  }
  }
}
