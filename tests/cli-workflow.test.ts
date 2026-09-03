import { describe, expect, it, vi } from "vitest";
import { BackRequestedError, type CliIO } from "../scripts/cli-io";
import { runCliWorkflow, type CliWorkflowDependencies } from "../scripts/cli-workflow";
import type { LocalProfileRepository } from "../scripts/local-profile-repository";
import type { LocalProfileSelection, SubscriptionInspectionSummary } from "../src/subscription-inspection";
import type { GenerationResult, GeneratorSpec } from "../src/types";

type ScriptedStep =
  | { method: "ask"; value: string | "back" }
  | { method: "choose"; value: number | "back" }
  | { method: "confirm"; value: boolean | "back" };

function scriptedIo(steps: ScriptedStep[]): CliIO & {
  output: string[];
  menus: Array<{ prompt: string; options: string[] }>;
  zeroLabels: Array<string | undefined>;
  confirmations: string[];
} {
  const output: string[] = [];
  const menus: Array<{ prompt: string; options: string[] }> = [];
  const zeroLabels: Array<string | undefined> = [];
  const confirmations: string[] = [];
  const take = <T extends ScriptedStep["method"]>(method: T) => {
    const step = steps.shift();
    if (!step || step.method !== method) {
      throw new Error(`expected-${method}-got-${step?.method ?? "nothing"}`);
    }
    return step.value as Extract<ScriptedStep, { method: T }>["value"];
  };
  return {
    output,
    menus,
    zeroLabels,
    confirmations,
    setLanguage() {},
    async ask() {
      const value = take("ask");
      if (value === "back") throw new BackRequestedError();
      return value;
    },
    async choose(prompt, options, zeroLabel) {
      menus.push({ prompt, options: [...options] });
      zeroLabels.push(zeroLabel);
      const value = take("choose");
      if (value === "back") throw new BackRequestedError();
      if (value < 0 || value >= options.length) {
        throw new Error(`scripted-choice-out-of-range-${value}-of-${options.length}`);
      }
      return value;
    },
    async confirm(prompt) {
      confirmations.push(prompt);
      const value = take("confirm");
      if (value === "back") throw new BackRequestedError();
      return value;
    },
    writeLine(message = "") { output.push(message); },
    close() {},
  };
}

const mainUrl = "https://main.example.test/private-main-token";
const childUrl = "https://child.example.test/private-child-token";
const secondChildUrl = "https://second-child.example.test/private-second-token";

function inspection(
  name: string,
  selectGroups: string[],
  origin: SubscriptionInspectionSummary["origin"] = "local",
  suggestedGroup: string | null = selectGroups.length === 1 ? selectGroups[0]! : null,
): SubscriptionInspectionSummary {
  return {
    status: "available",
    name,
    nameSource: origin === "local" ? "local" : "profile-title",
    origin,
    format: "clash-yaml",
    selectGroups,
    suggestedGroup,
    nodeCount: 2,
    warnings: [],
  };
}

function localSelection(profileId: string, name: string, source: string, groups: string[]): LocalProfileSelection {
  return { profileId, name, source, inspection: inspection(name, groups) };
}

function localRepository(
  selections: LocalProfileSelection[],
  currentProfileId?: string,
): LocalProfileRepository {
  return {
    async list() {
      return selections.map(({ profileId: id, name }) => ({
        id,
        name,
        status: "available" as const,
        ...(id === currentProfileId ? { isCurrent: true as const } : {}),
      }));
    },
    async select(profileId) {
      return selections.find((selection) => selection.profileId === profileId) ?? null;
    },
    async findBySource(source) {
      return selections.find((selection) => selection.source === source) ?? null;
    },
    async installManagedScript() {
      return { status: "write-failed" };
    },
  };
}

const validResult: GenerationResult = {
  valid: true,
  operation: "apply",
  fullScript: `// ${mainUrl}\n// ${childUrl}\nreturn config;`,
  maskedScript: "// https://••••••••••••\nreturn config;",
  diagnostics: [{
    code: "generated",
    severity: "success",
    message: { zh: "生成成功", en: "Generated" },
  }],
  topology: {
    targetProfileName: "Main",
    parentGroupMode: "manual",
    parentGroupName: "PROXY",
    children: [{ groupName: "Child", providerMode: "http", nodePrefix: "[Child] " }],
    removedChildren: [],
    keptCount: 1,
    removedCount: 0,
    aiEnabled: false,
  },
};

const regeneratedResult: GenerationResult = {
  ...validResult,
  fullScript: `// ${mainUrl}\n// ${childUrl}\n// ${secondChildUrl}\nreturn config;`,
  maskedScript: "// https://••••••••••••\n// two children\nreturn config;",
  topology: {
    ...validResult.topology,
    children: [
      ...validResult.topology.children,
      { groupName: "Second child", providerMode: "http", nodePrefix: "[Second child] " },
    ],
    keptCount: 2,
  },
};

function dependencies(
  io: CliIO,
  profiles: LocalProfileRepository,
  overrides: Partial<CliWorkflowDependencies> = {},
): CliWorkflowDependencies {
  return {
    io,
    profiles,
    inspectRemote: vi.fn(),
    generate: vi.fn(() => validResult),
    copyScript: vi.fn(),
    createChildId: (() => {
      let sequence = 0;
      return () => `child-${++sequence}`;
    })(),
    ...overrides,
  };
}

describe("CLI workflow", () => {
  it("exits from the first language menu when zero is selected", async () => {
    const io = scriptedIo([
      { method: "choose", value: "back" },
    ]);

    await expect(runCliWorkflow(dependencies(io, localRepository([])))).resolves.toBe("completed");

    expect(io.menus).toEqual([{
      prompt: "请选择语言 / Choose language",
      options: ["中文", "English"],
    }]);
    expect(io.zeroLabels).toEqual(["退出 / Exit"]);
    expect(io.output.join("\n")).not.toContain("已经是第一步");
  });

  it("uses the sole detected parent group without showing a parent-group menu", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ], "main"), { generate }));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      parentGroupMode: "manual",
      parentGroupName: "PROXY",
    }));
    expect(io.menus.some((menu) => menu.prompt.includes("主代理组"))).toBe(false);
  });

  it("returns to target selection when no real parent group was detected", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
    ]);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, []),
      localSelection("alternate", "Alternate", "https://alternate.example.test/subscription", ["ALT"]),
      localSelection("child", "Child", childUrl, []),
    ], "main")));

    expect(io.output).toContain("未发现可用主代理组，请重新检查或选择其他目标主订阅。");
    expect(io.menus.filter((menu) => menu.prompt === "选择目标主订阅")).toHaveLength(2);
  });

  it("offers only detected parent groups when several are available", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY", "FALLBACK"]),
      localSelection("child", "Child", childUrl, []),
    ], "main")));

    expect(io.menus).toContainEqual({
      prompt: "选择主代理组（共 2 个）",
      options: ["PROXY", "FALLBACK"],
    });
  });

  it("lets the user supply an install or configuration directory when automatic discovery finds nothing", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "ask", value: "D:\\Portable\\Clash Verge" },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const selections = [
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ];
    let loaded = false;
    const addProfileLocation = vi.fn(async () => {
      loaded = true;
      return { status: "loaded" as const, profileCount: selections.length };
    });
    const profiles: LocalProfileRepository = {
      async list() {
        return loaded ? selections.map(({ profileId: id, name }) => ({
          id,
          name,
          status: "available" as const,
          ...(id === "main" ? { isCurrent: true as const } : {}),
        })) : [];
      },
      async select(profileId) {
        return selections.find((selection) => selection.profileId === profileId) ?? null;
      },
      async findBySource(source) {
        return selections.find((selection) => selection.source === source) ?? null;
      },
      addProfileLocation,
      async installManagedScript() {
        return { status: "write-failed" };
      },
    };

    await runCliWorkflow(dependencies(io, profiles));

    expect(addProfileLocation).toHaveBeenCalledWith("D:\\Portable\\Clash Verge");
    expect(io.output.join("\n")).toContain("已识别 2 个本机订阅");
    expect(io.menus).toContainEqual({
      prompt: "未自动找到 Clash Verge Rev 配置。请先在 Clash Verge Rev 导入目标主订阅，或指定正确的配置位置。",
      options: ["指定 Clash Verge Rev 安装目录或配置目录"],
    });
  });

  it("returns from the configuration path input to the preceding recovery menu", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "ask", value: "back" },
      { method: "choose", value: "back" },
      { method: "choose", value: "back" },
    ]);
    const addProfileLocation = vi.fn();
    const profiles: LocalProfileRepository = {
      ...localRepository([]),
      addProfileLocation,
    };

    await runCliWorkflow(dependencies(io, profiles));

    expect(addProfileLocation).not.toHaveBeenCalled();
    expect(io.menus.filter((menu) => menu.prompt.includes("未自动找到"))).toHaveLength(2);
  });

  it("defaults to the Clash Verge Rev current profile as the target", async () => {
    const alternateUrl = "https://alternate.example.test/subscription";
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);
    const profiles = localRepository([
      localSelection("alternate", "Alternate", alternateUrl, ["OTHER"]),
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ], "main");

    await runCliWorkflow(dependencies(io, profiles, { generate }));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      targetProfile: { name: "Main", source: mainUrl },
    }));
    expect(io.menus).toContainEqual({
      prompt: "选择目标主订阅",
      options: [
        "Main（当前，推荐）",
        "Alternate",
        "Child",
      ],
    });
    expect(io.menus.some((menu) => menu.prompt.includes("检测到 Clash Verge Rev 当前主订阅"))).toBe(false);
  });

  it("still allows manually choosing a different local target", async () => {
    const alternateUrl = "https://alternate.example.test/subscription";
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);
    const profiles = localRepository([
      localSelection("alternate", "Alternate", alternateUrl, ["OTHER"]),
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ], "main");

    await runCliWorkflow(dependencies(io, profiles, { generate }));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      targetProfile: { name: "Alternate", source: alternateUrl },
    }));
  });

  it("exits from the unified target list when zero is selected", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ], "main")));

    expect(io.menus.filter((menu) => menu.prompt === "选择目标主订阅")).toHaveLength(1);
    expect(io.menus.filter((menu) => menu.options[0] === "Main（当前，推荐）")).toHaveLength(1);
    expect(io.menus.filter((menu) => menu.prompt === "请选择语言 / Choose language")).toHaveLength(1);
    expect(io.zeroLabels).toEqual(["退出 / Exit", "退出"]);
  });

  it("returns from the parent-group step to the target list that selected the target", async () => {
    const alternateUrl = "https://alternate.example.test/private-token";
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
    ]);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("alternate", "Alternate", alternateUrl, ["OTHER", "FALLBACK"]),
      localSelection("child", "Child", childUrl, []),
    ], "main")));

    expect(io.menus.filter((menu) => menu.prompt === "选择目标主订阅")).toHaveLength(2);
    expect(io.menus.filter((menu) => menu.options[0] === "Main（当前，推荐）")).toHaveLength(2);
  });

  it("shows every detected parent group in one menu and preserves emoji-prefixed names", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 6 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);
    const main = localSelection(
      "main",
      "Main",
      mainUrl,
      [
        "🔯自动选择",
        "🧭媒体解锁",
        "🌐国际",
        "🛡️吉娃娃",
        "👍🏽媒体",
        "🇨🇳中国",
        "1️⃣节点",
        "★媒体",
        "漏网之鱼",
      ],
    );
    main.inspection.suggestedGroup = "漏网之鱼";

    await runCliWorkflow(dependencies(io, localRepository([
      main,
      localSelection("child", "Child", childUrl, []),
    ], "main"), { generate }));

    expect(io.menus).toContainEqual({
      prompt: "选择主代理组（共 9 个）",
      options: [
        "🔯 自动选择",
        "🧭 媒体解锁",
        "🌐 国际",
        "🛡️ 吉娃娃",
        "👍🏽 媒体",
        "🇨🇳 中国",
        "1️⃣ 节点",
        "★ 媒体",
        "漏网之鱼",
      ],
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      parentGroupMode: "manual",
      parentGroupName: "1️⃣节点",
    }));
  });

  it("paginates detected parent groups at ten per page and preserves the selected original name", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 10 },
      { method: "choose", value: 1 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);
    const groups = Array.from({ length: 12 }, (_, index) => `GROUP ${index + 1}`);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, groups),
      localSelection("child", "Child", childUrl, []),
    ], "main"), { generate }));

    expect(io.menus).toContainEqual({
      prompt: "选择主代理组（共 12 个，第 1/2 页）",
      options: [
        ...groups.slice(0, 10),
        "下一页",
        "输入关键词筛选",
      ],
    });
    expect(io.menus).toContainEqual({
      prompt: "选择主代理组（共 12 个，第 2/2 页）",
      options: [
        ...groups.slice(10),
        "上一页",
        "输入关键词筛选",
      ],
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      parentGroupMode: "manual",
      parentGroupName: "GROUP 12",
    }));
  });

  it("filters long parent-group lists by keyword without inferring a recommendation", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 11 },
      { method: "ask", value: "hong" },
      { method: "choose", value: 1 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);
    const groups = [
      ...Array.from({ length: 10 }, (_, index) => `GROUP ${index + 1}`),
      "Hong Kong",
      "Hong Kong Premium",
    ];

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, groups),
      localSelection("child", "Child", childUrl, []),
    ], "main"), { generate }));

    expect(io.menus).toContainEqual({
      prompt: "选择主代理组（筛选后 2/12 个，第 1/1 页）",
      options: [
        "Hong Kong",
        "Hong Kong Premium",
        "输入关键词筛选",
      ],
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      parentGroupMode: "manual",
      parentGroupName: "Hong Kong Premium",
    }));
  });

  it("returns from the second parent-group page and clears an active filter", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 10 },
      { method: "choose", value: 2 },
      { method: "choose", value: 11 },
      { method: "ask", value: "GROUP 12" },
      { method: "choose", value: 1 },
      { method: "ask", value: "" },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);
    const groups = Array.from({ length: 12 }, (_, index) => `GROUP ${index + 1}`);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, groups),
      localSelection("child", "Child", childUrl, []),
    ], "main"), { generate }));

    expect(io.menus).toContainEqual({
      prompt: "选择主代理组（共 12 个，第 2/2 页）",
      options: ["GROUP 11", "GROUP 12", "上一页", "输入关键词筛选"],
    });
    expect(io.menus).toContainEqual({
      prompt: "选择主代理组（筛选后 1/12 个，第 1/1 页）",
      options: ["GROUP 12", "输入关键词筛选"],
    });
    expect(io.menus.filter((menu) => menu.prompt === "选择主代理组（共 12 个，第 1/2 页）"))
      .toHaveLength(3);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      parentGroupMode: "manual",
      parentGroupName: "GROUP 1",
    }));
  });

  it("keeps parent-group filtering usable after no matches", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 11 },
      { method: "ask", value: "missing" },
      { method: "choose", value: 11 },
      { method: "ask", value: "hong" },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);
    const groups = [
      ...Array.from({ length: 10 }, (_, index) => `GROUP ${index + 1}`),
      "Hong Kong",
      "Hong Kong Premium",
    ];

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, groups),
      localSelection("child", "Child", childUrl, []),
    ], "main"), { generate }));

    expect(io.output).toContain("没有找到匹配的主代理组。");
    expect(io.menus.filter((menu) => menu.prompt === "选择主代理组（筛选后 2/12 个，第 1/1 页）"))
      .toHaveLength(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      parentGroupMode: "manual",
      parentGroupName: "Hong Kong",
    }));
  });

  it("warns when the detected parent-group list reached the safety limit", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const main = localSelection("main", "Main", mainUrl, ["PROXY", "FALLBACK"]);
    main.inspection.warnings.push("select-groups-truncated");

    await runCliWorkflow(dependencies(io, localRepository([
      main,
      localSelection("child", "Child", childUrl, []),
    ], "main")));

    expect(io.output).toContain("检测到的主代理组超过 256 个，仅显示前 256 个。");
  });

  it("reviews direction once, writes, and ends on a completion page", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const profiles = localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]);
    const installManagedScript = vi.spyOn(profiles, "installManagedScript")
      .mockResolvedValue({ status: "written", targetIsCurrent: true });

    await runCliWorkflow(dependencies(io, profiles));

    expect(installManagedScript).toHaveBeenCalledWith("main", validResult.fullScript);
    expect(io.menus).toContainEqual({
      prompt: "请检查方向并选择交付方式：目标主订阅：Main；主代理组：PROXY；子订阅与子组：Child → Child。",
      options: [
        "方向正确，一键写入 Clash Verge Rev（推荐）",
        "方向正确，复制完整脚本",
        "选择有误，重新配置",
      ],
    });
    expect(io.menus).toContainEqual({
      prompt: "✓ 写入完成。无需更新主订阅；请回 Clash Verge Rev 重新激活当前订阅后检查生效。",
      options: ["重新配置"],
    });
    expect(io.zeroLabels.at(-1)).toBe("完成并退出");
    expect(io.output.join("\n")).not.toContain(validResult.fullScript);
  });

  it("tells the user to activate a non-current target without claiming an update", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: 1 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const profiles = localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("alternate", "Alternate", "https://alternate.example.test/token", ["ALT"]),
      localSelection("child", "Child", childUrl, []),
    ], "main");
    vi.spyOn(profiles, "installManagedScript")
      .mockResolvedValue({ status: "written", targetIsCurrent: false });

    await runCliWorkflow(dependencies(io, profiles));

    expect(io.menus.at(-1)?.prompt).toBe(
      "✓ 写入完成。请回 Clash Verge Rev 激活目标订阅后检查生效。",
    );
    expect(io.menus.at(-1)?.prompt).not.toContain("更新主订阅");
  });

  it("keeps a safe write refusal out of the completion state", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const profiles = localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]);
    vi.spyOn(profiles, "installManagedScript")
      .mockResolvedValue({ status: "custom-script-conflict" });

    await runCliWorkflow(dependencies(io, profiles));

    expect(io.output.join("\n")).toContain("已有其他自定义脚本");
    expect(io.menus.some((menu) => menu.prompt.startsWith("✓ 写入完成"))).toBe(false);
  });

  it.each([
    ["target-missing", "目标订阅已不存在"],
    ["concurrent-change", "配置已变化"],
  ] as const)("restarts target collection after %s", async (status, expectedMessage) => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const profiles = localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]);
    vi.spyOn(profiles, "installManagedScript").mockResolvedValue({ status });

    await runCliWorkflow(dependencies(io, profiles));

    expect(io.output.join("\n")).toContain(expectedMessage);
    expect(io.menus.filter((menu) => menu.prompt === "选择目标主订阅")).toHaveLength(2);
    expect(io.menus.some((menu) => menu.prompt.startsWith("✓ 写入完成"))).toBe(false);
  });

  it("keeps a clipboard failure out of the completion state", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
    ]);
    const copyScript = vi.fn().mockResolvedValue(false);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]), { copyScript }));

    expect(io.output.join("\n")).toContain("无法写入系统剪贴板");
    expect(io.menus.some((menu) => menu.prompt.startsWith("✓ 脚本已复制"))).toBe(false);
  });

  it("returns from the parent-group step to choose a different target profile", async () => {
    const alternateMainUrl = "https://alternate-main.example.test/private-token";
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
      { method: "choose", value: 1 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main-a", "Main A", mainUrl, ["PROXY", "FALLBACK"]),
      localSelection("main-b", "Main B", alternateMainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]), { generate }));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      targetProfile: { name: "Main B", source: alternateMainUrl },
    }));
  });

  it("returns from remote child consent to re-enter the preceding URL", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "ask", value: childUrl },
      { method: "confirm", value: "back" },
      { method: "ask", value: secondChildUrl },
      { method: "confirm", value: true },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]), {
      generate,
      inspectRemote: vi.fn(async () => inspection("Remote child", [], "remote")),
    }));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      children: [expect.objectContaining({ source: secondChildUrl })],
    }));
  });

  it("uses the selected local child name as its default group name", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child-a", "Child A", childUrl, []),
      localSelection("child-b", "Child B", secondChildUrl, []),
    ]), { generate }));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      children: [expect.objectContaining({
        source: secondChildUrl,
        groupName: "Child B",
        groupNameManuallyEdited: false,
      })],
    }));
  });

  it("returns from a manual child URL to the preceding child selection", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "ask", value: "back" },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ], "main")));

    expect(io.menus.filter((menu) => menu.prompt.startsWith("选择子订阅"))).toHaveLength(2);
  });

  it("returns from appending a child to the preview menu without changing the draft", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
      localSelection("second", "Second", secondChildUrl, []),
    ]), { generate }));

    expect(generate).toHaveBeenCalledOnce();
  });

  it("returns from direction review to the preview menu", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
      { method: "choose", value: "back" },
    ]);
    const copyScript = vi.fn();

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]), { copyScript }));

    expect(copyScript).not.toHaveBeenCalled();
  });

  it("returns to target selection when the user says the direction is reversed", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 2 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const copyScript = vi.fn();

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]), { copyScript }));

    expect(copyScript).not.toHaveBeenCalled();
    expect(io.menus.filter((menu) => menu.prompt === "选择目标主订阅")).toHaveLength(2);
  });

  it("returns from the preview menu to rename the most recently selected child", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 2 },
      { method: "ask", value: "Renamed child" },
      { method: "choose", value: "back" },
    ]);
    const generatedSpecs: GeneratorSpec[] = [];
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>((spec) => {
      generatedSpecs.push(spec);
      return validResult;
    });

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]), { generate }));

    expect(generatedSpecs).toHaveLength(2);
    expect(generatedSpecs[1]!.children[0]!.groupName).toBe("Renamed child");
  });

  it("copies from the single direction review and ends on a completion page", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
    ]);
    const copyScript = vi.fn().mockResolvedValue(true);

    await runCliWorkflow(dependencies(
      io,
      localRepository([
        localSelection("main", "Main", mainUrl, ["PROXY"]),
        localSelection("child", "Child", childUrl, []),
      ]),
      { copyScript },
    ));

    expect(copyScript).toHaveBeenCalledOnce();
    expect(copyScript).toHaveBeenCalledWith(validResult.fullScript);
    expect(io.menus).toContainEqual({
      prompt: "请检查方向并选择交付方式：目标主订阅：Main；主代理组：PROXY；子订阅与子组：Child → Child。",
      options: [
        "方向正确，一键写入 Clash Verge Rev（推荐）",
        "方向正确，复制完整脚本",
        "选择有误，重新配置",
      ],
    });
    expect(io.output.join("\n")).not.toContain(validResult.fullScript);
    expect(io.menus).toContainEqual({
      prompt: "✓ 脚本已复制。粘贴到目标订阅的扩展脚本后，请重新激活该订阅。",
      options: ["重新配置"],
    });
  });

  it("builds a local spec and keeps the generated script hidden by default", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);
    const profiles = localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]);

    await runCliWorkflow(dependencies(io, profiles, { generate }));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      targetProfile: { name: "Main", source: mainUrl },
      parentGroupMode: "manual",
      parentGroupName: "PROXY",
      children: [expect.objectContaining({
        groupName: "Child",
        groupNameManuallyEdited: false,
        source: childUrl,
        mode: "http",
      })],
      ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
    }));
    expect(generate.mock.calls[0]![0].children[0]).not.toHaveProperty("selectedProxyGroup");
    expect(io.output.join("\n")).toContain("✓ 已生成：Main → PROXY；子订阅 1 个");
    expect(io.output).not.toContain(validResult.maskedScript);
    expect(io.output.join("\n")).not.toContain(validResult.fullScript);
    expect(io.output.join("\n")).not.toContain("private-main-token");
    expect(io.output.join("\n")).not.toContain("private-child-token");
  });

  it("shows the masked script only after the user requests it from the preview menu", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 4 },
      { method: "choose", value: "back" },
    ]);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ])));

    expect(io.output).toContain("遮罩预览");
    expect(io.output).toContain(validResult.maskedScript);
    expect(io.output.join("\n")).not.toContain(validResult.fullScript);
    expect(io.output.join("\n")).not.toContain("private-main-token");
    expect(io.output.join("\n")).not.toContain("private-child-token");
  });

  it("never inspects a manually entered child URL when the user declines", async () => {
    const io = scriptedIo([
      { method: "choose", value: 1 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "ask", value: secondChildUrl },
      { method: "confirm", value: false },
      { method: "ask", value: "Manual child" },
      { method: "choose", value: "back" },
    ]);
    const inspectRemote = vi.fn();

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]), { inspectRemote }));

    expect(inspectRemote).not.toHaveBeenCalled();
  });

  it("inspects a manual child URL only after consent and uses English diagnostics", async () => {
    const io = scriptedIo([
      { method: "choose", value: 1 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "ask", value: secondChildUrl },
      { method: "confirm", value: true },
      { method: "choose", value: "back" },
    ]);
    const inspectRemote = vi.fn(async () => inspection("Remote child", [], "remote"));

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]), { inspectRemote }));

    expect(inspectRemote).toHaveBeenCalledWith(secondChildUrl);
    expect(io.output.join("\n")).toContain("Generated");
    expect(io.output.join("\n")).not.toContain("生成成功");
    expect(io.output.join("\n")).not.toContain("private-main-token");
    expect(io.output.join("\n")).not.toContain("private-second-token");
  });

  it("asks for a child name when confirmed remote inspection does not provide one", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "ask", value: secondChildUrl },
      { method: "confirm", value: true },
      { method: "ask", value: "Manual child name" },
      { method: "choose", value: "back" },
    ]);
    const namelessInspection: SubscriptionInspectionSummary = {
      ...inspection("unused", [], "remote"),
      name: null,
      nameSource: null,
    };
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);

    await runCliWorkflow(dependencies(io, localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]), {
      inspectRemote: vi.fn(async () => namelessInspection),
      generate,
    }));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      targetProfile: { name: "Main", source: mainUrl },
      children: [expect.objectContaining({ groupName: "Manual child name", source: secondChildUrl })],
    }));
  });

  it("does not offer export for an invalid generation", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const invalidResult: GenerationResult = { ...validResult, valid: false, fullScript: "", maskedScript: "" };
    const copyScript = vi.fn();

    await runCliWorkflow(dependencies(
      io,
      localRepository([
        localSelection("main", "Main", mainUrl, ["PROXY"]),
        localSelection("child", "Child", childUrl, []),
      ]),
      { generate: vi.fn(() => invalidResult), copyScript },
    ));

    expect(copyScript).not.toHaveBeenCalled();
    expect(io.output.join("\n")).toContain("不能导出");
  });

  it("restarts collection when returning from an invalid result without hidden editing", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: "back" },
    ]);
    const invalidResult: GenerationResult = { ...validResult, valid: false, fullScript: "", maskedScript: "" };
    const generate = vi.fn(() => invalidResult);

    await runCliWorkflow(dependencies(
      io,
      localRepository([
        localSelection("main", "Main", mainUrl, ["PROXY"]),
        localSelection("child", "Child", childUrl, []),
      ]),
      { generate },
    ));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(io.output.filter((line) => line.includes("不能导出"))).toHaveLength(2);
  });

  it("automatically regenerates after appending a child before export", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: 1 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
    ]);
    const profiles = localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
      localSelection("second", "Second child", secondChildUrl, []),
    ]);
    const generate = vi.fn()
      .mockReturnValueOnce(validResult)
      .mockReturnValueOnce(regeneratedResult);
    const copyScript = vi.fn().mockResolvedValue(true);

    await runCliWorkflow(dependencies(io, profiles, { generate, copyScript }));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(copyScript).toHaveBeenCalledTimes(1);
    expect(copyScript).toHaveBeenCalledWith(regeneratedResult.fullScript);
    expect(copyScript).not.toHaveBeenCalledWith(validResult.fullScript);
    expect(io.menus.filter((menu) => menu.prompt === "请选择下一步").at(-1)?.options).toEqual([
      "检查方向并继续（推荐）",
      "追加子订阅",
      "修改最后一个子组名称",
      "查看配置详情",
      "查看遮罩脚本",
      "重新开始配置",
    ]);
    expect(io.menus.some((menu) => menu.prompt === "更多操作")).toBe(false);
  });

  it("rejects a duplicate local child and allows manual fallback", async () => {
    const io = scriptedIo([
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 1 },
      { method: "ask", value: secondChildUrl },
      { method: "confirm", value: false },
      { method: "ask", value: "Second child" },
      { method: "choose", value: "back" },
    ]);
    const profiles = localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      localSelection("child", "Child", childUrl, []),
    ]);
    const generatedSpecs: GeneratorSpec[] = [];
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>((spec) => {
      generatedSpecs.push(spec);
      return spec.children.length === 1 ? validResult : regeneratedResult;
    });

    await runCliWorkflow(dependencies(io, profiles, { generate }));

    expect(generatedSpecs.at(-1)?.children.map((child) => child.source)).toEqual([childUrl, secondChildUrl]);
    expect(io.output.join("\n")).toContain("已经被使用");
  });

  it("stops appending at 64 child subscriptions with an explicit message", async () => {
    const steps: ScriptedStep[] = [
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
      { method: "choose", value: 0 },
    ];
    for (let index = 1; index < 64; index += 1) {
      steps.push(
        { method: "choose", value: 1 },
        { method: "choose", value: index },
      );
    }
    steps.push(
      { method: "choose", value: 1 },
      { method: "choose", value: "back" },
      { method: "choose", value: "back" },
    );
    const io = scriptedIo(steps);
    const profiles = localRepository([
      localSelection("main", "Main", mainUrl, ["PROXY"]),
      ...Array.from({ length: 65 }, (_, index) => localSelection(
        `child-${index + 1}`,
        `Child ${index + 1}`,
        `https://child-${index + 1}.example.test/private-token`,
        [],
      )),
    ]);
    const generate = vi.fn<(spec: GeneratorSpec) => GenerationResult>(() => validResult);

    await runCliWorkflow(dependencies(io, profiles, { generate }));

    expect(io.menus.filter((menu) => menu.prompt === "选择子订阅（使用该订阅中的全部节点）"))
      .toHaveLength(64);
    expect(io.output.join("\n")).toContain("最多支持 64 个子订阅");
    expect(generate).toHaveBeenCalledTimes(64);
  });
});
