import type { Language } from "../src/types.ts";

interface ChildDirection {
  subscriptionName: string;
  groupName: string;
}

const messages = {
  zh: {
    title: "Clash Verge Kit CLI",
    privacy: "订阅地址输入时可见；之后不会在摘要或日志中回显。",
    targetSelect: "选择目标主订阅",
    currentTargetOption: (name: string) => `${name}（当前，推荐）`,
    childSelect: "选择子订阅（使用该订阅中的全部节点）",
    parentGroupSelect: (count: number, page: number, pageCount: number, filteredCount: number | null) => filteredCount === null
      ? pageCount === 1
        ? `选择主代理组（共 ${count} 个）`
        : `选择主代理组（共 ${count} 个，第 ${page}/${pageCount} 页）`
      : `选择主代理组（筛选后 ${filteredCount}/${count} 个，第 ${page}/${pageCount} 页）`,
    previousPage: "上一页",
    nextPage: "下一页",
    filterParentGroups: "输入关键词筛选",
    parentGroupFilter: "输入主代理组关键词（直接回车清除筛选）：",
    noMatchingParentGroups: "没有找到匹配的主代理组。",
    noDetectedParentGroup: "未发现可用主代理组，请重新检查或选择其他目标主订阅。",
    singleParentGroupSelected: (name: string) => `已自动使用唯一检测到的主代理组：${name}`,
    parentGroupsTruncated: (limit: number) => `检测到的主代理组超过 ${limit} 个，仅显示前 ${limit} 个。`,
    manual: "手工输入",
    childUrl: "输入子订阅 HTTPS URL：",
    inspectUrl: "是否联网检查这个订阅？",
    childName: "输入子订阅名称：",
    childGroupName: (fallback: string) => `输入新子组名称（直接回车使用 ${fallback}）：`,
    required: "此项不能为空。",
    invalidName: "名称无效：最多 128 个字符，且不能包含终端控制字符。",
    invalidHttps: "请输入有效的 HTTPS URL。",
    inspectionFailed: "订阅检查失败，请手工补充子订阅名称或返回重新输入地址。",
    duplicateSource: "这个订阅已经被使用，请选择或输入另一个订阅。",
    childLimitReached: (limit: number) => `最多支持 ${limit} 个子订阅，不能继续追加。`,
    generatedSummary: (target: string, parent: string, count: number) =>
      `✓ 已生成：${target} → ${parent}；子订阅 ${count} 个`,
    topology: "配置详情",
    diagnostics: "校验信息",
    maskedPreview: "遮罩预览",
    previewAction: "请选择下一步",
    reviewAndDeliver: "检查方向并继续（推荐）",
    renameChild: "修改最后一个子组名称",
    showDetails: "查看配置详情",
    showMaskedScript: "查看遮罩脚本",
    addChild: "追加子订阅",
    restart: "重新开始配置",
    exit: "退出",
    noLocalProfiles: "未发现可用于当前步骤的本机订阅，进入手工输入。",
    noLocalProfileAction: "未自动找到 Clash Verge Rev 配置。请先在 Clash Verge Rev 导入目标主订阅，或指定正确的配置位置。",
    locateProfileDirectory: "指定 Clash Verge Rev 安装目录或配置目录",
    noLocalTargetProfiles: "未发现已导入的目标主订阅，请先在 Clash Verge Rev 导入后重新运行。",
    profileDirectoryPath: "输入安装目录、配置目录或 profiles.yaml 路径：",
    profileDirectoryLoaded: (count: number) => `已识别 ${count} 个本机订阅。`,
    profileDirectoryNotFound: "该位置没有找到可用的 Clash Verge Rev profiles.yaml，请重新选择。",
    invalidResult: "当前结果无效，不能导出。",
    deliveryReview: (targetName: string, parentGroupName: string, children: readonly ChildDirection[]) =>
      `请检查方向并选择交付方式：目标主订阅：${targetName}；主代理组：${parentGroupName}；子订阅与子组：${children
        .map((child) => `${child.subscriptionName} → ${child.groupName}`)
        .join("；")}。`,
    directionCopyCorrect: "方向正确，复制完整脚本",
    directionWriteCorrect: "方向正确，一键写入 Clash Verge Rev（推荐）",
    directionReversed: "选择有误，重新配置",
    clipboardFailed: "无法写入系统剪贴板，未复制脚本。",
    copyCompleted: "✓ 脚本已复制。粘贴到目标订阅的扩展脚本后，请重新激活该订阅。",
    writeCompleted: (targetIsCurrent: boolean) => targetIsCurrent
      ? "✓ 写入完成。无需更新主订阅；请回 Clash Verge Rev 重新激活当前订阅后检查生效。"
      : "✓ 写入完成。请回 Clash Verge Rev 激活目标订阅后检查生效。",
    reconfigure: "重新配置",
    finishAndExit: "完成并退出",
    writeNotLinked: "目标订阅没有可安全定位的独立扩展脚本，请先在 Clash Verge Rev 中启用扩展脚本。",
    writeConflict: "目标位置已有其他自定义脚本，已拒绝覆盖。",
    writeChanged: "写入前检测到 Clash Verge Rev 配置已变化，请重新选择后再试。",
    writeTargetMissing: "目标订阅已不存在，请重新选择后再试。",
    writeFailed: "无法安全写入 Clash Verge Rev，请到目标订阅的扩展脚本中检查当前内容。",
    internalError: "发生内部错误。",
  },
  en: {
    title: "Clash Verge Kit CLI",
    privacy: "Subscription URLs are visible while entered, then are not repeated in summaries or logs.",
    targetSelect: "Select the target profile",
    currentTargetOption: (name: string) => `${name} (current, recommended)`,
    childSelect: "Select a child subscription (all nodes from this subscription)",
    parentGroupSelect: (count: number, page: number, pageCount: number, filteredCount: number | null) => filteredCount === null
      ? pageCount === 1
        ? `Select the parent proxy group (${count} detected)`
        : `Select the parent proxy group (${count} detected, page ${page}/${pageCount})`
      : `Select the parent proxy group (${filteredCount}/${count} after filtering, page ${page}/${pageCount})`,
    previousPage: "Previous page",
    nextPage: "Next page",
    filterParentGroups: "Filter by keyword",
    parentGroupFilter: "Enter a parent proxy group keyword (press Enter to clear the filter): ",
    noMatchingParentGroups: "No matching parent proxy group was found.",
    noDetectedParentGroup: "No usable parent proxy group was detected. Inspect again or choose another target profile.",
    singleParentGroupSelected: (name: string) => `Using the only detected parent proxy group automatically: ${name}`,
    parentGroupsTruncated: (limit: number) => `More than ${limit} parent proxy groups were detected. Only the first ${limit} are shown.`,
    manual: "Enter manually",
    childUrl: "Enter the child subscription HTTPS URL: ",
    inspectUrl: "Inspect this subscription over the network?",
    childName: "Enter the child subscription name: ",
    childGroupName: (fallback: string) => `Enter the new child group name (press Enter for ${fallback}): `,
    required: "This value is required.",
    invalidName: "The name is invalid. Use at most 128 characters and no terminal control characters.",
    invalidHttps: "Enter a valid HTTPS URL.",
    inspectionFailed: "Subscription inspection failed. Enter the child subscription name manually or go back and enter the URL again.",
    duplicateSource: "This subscription is already in use. Choose or enter another subscription.",
    childLimitReached: (limit: number) => `At most ${limit} child subscriptions are supported. No more can be added.`,
    generatedSummary: (target: string, parent: string, count: number) =>
      `✓ Generated: ${target} → ${parent}; ${count} child subscription(s)`,
    topology: "Configuration details",
    diagnostics: "Validation",
    maskedPreview: "Masked preview",
    previewAction: "Choose the next step",
    reviewAndDeliver: "Review direction and continue (recommended)",
    renameChild: "Rename the last child group",
    showDetails: "View configuration details",
    showMaskedScript: "View the masked script",
    addChild: "Add a child subscription",
    restart: "Start over",
    exit: "Exit",
    noLocalProfiles: "No eligible local subscription was found for this step. Switching to manual input.",
    noLocalProfileAction: "Clash Verge Rev configuration was not found automatically. Import the target profile in Clash Verge Rev first, or specify the correct configuration location.",
    locateProfileDirectory: "Specify the Clash Verge Rev install or configuration directory",
    noLocalTargetProfiles: "No imported target profile was found. Import it in Clash Verge Rev, then run this tool again.",
    profileDirectoryPath: "Enter an install directory, configuration directory, or profiles.yaml path: ",
    profileDirectoryLoaded: (count: number) => `${count} local profile(s) detected.`,
    profileDirectoryNotFound: "No usable Clash Verge Rev profiles.yaml was found there. Choose again.",
    invalidResult: "The current result is invalid and cannot be exported.",
    deliveryReview: (targetName: string, parentGroupName: string, children: readonly ChildDirection[]) =>
      `Review the direction and choose delivery: target profile: ${targetName}; parent proxy group: ${parentGroupName}; child subscriptions and groups: ${children
        .map((child) => `${child.subscriptionName} → ${child.groupName}`)
        .join("; ")}.`,
    directionCopyCorrect: "The direction is correct. Copy the full script",
    directionWriteCorrect: "The direction is correct. Write to Clash Verge Rev (recommended)",
    directionReversed: "The selection is wrong. Reconfigure",
    clipboardFailed: "The system clipboard could not be written. The script was not copied.",
    copyCompleted: "✓ Script copied. Paste it into the target profile's extension script, then reactivate that profile.",
    writeCompleted: (targetIsCurrent: boolean) => targetIsCurrent
      ? "✓ Write complete. No subscription update is needed; reactivate the current profile in Clash Verge Rev and verify it."
      : "✓ Write complete. Activate the target profile in Clash Verge Rev and verify it.",
    reconfigure: "Reconfigure",
    finishAndExit: "Finish and exit",
    writeNotLinked: "No safe per-profile extension script is linked. Enable an extension script in Clash Verge Rev first.",
    writeConflict: "Another custom script already exists at the target. It was not overwritten.",
    writeChanged: "The Clash Verge Rev configuration changed before writing. Select the profiles again and retry.",
    writeTargetMissing: "The target profile no longer exists. Select it again and retry.",
    writeFailed: "Clash Verge Rev could not be written safely. Check the target profile's extension script content.",
    internalError: "An internal error occurred.",
  },
} as const;

export function getCliMessages(language: Language) {
  return messages[language];
}
