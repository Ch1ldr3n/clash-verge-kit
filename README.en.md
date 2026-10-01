# Clash Verge Kit

[简体中文](README.md) | [English](README.en.md)

Clash Verge Kit is a local command-line tool for [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev). It helps you organize multiple child subscriptions into separate proxy groups and safely add them to an existing primary subscription.

> Current status: this project has not been published to npm. Run it from source for now; there is no working one-command `npm` or `npx` installation yet.

The current development workspace supports AI routing: choose “AI routing only”, then reuse an existing `select` group or page, search and select nodes from the target and locally imported child subscriptions. Reopening restores saved settings for editing the outlet, changing selected nodes or disabling AI. Adding routing to an authenticated nesting script preserves its nesting relationships.

New plans use MetaCubeX's `category-ai-!cn` category, downloaded and refreshed by Mihomo; it includes some shared services and asset sites. Migrated plans retain their original rule sources. Reused groups retain their policies, including DIRECT. Selected-node groups block when a successful update removes every selected candidate; failed updates may retain the last valid candidates. Reactivate afterward and inspect rule downloads and connection records.

Manual selection requires a verified **stable Mihomo 1.19.29 or newer**. The local node list is an inspection snapshot, not a connectivity check; unreadable providers are not treated as empty. A first rule download failure may leave ordinary airport routing active. See the [current acceptance record](docs/research/2026-09-23-release-readiness.md) for tested behavior and limits.

## What problem does it solve?

Manually writing a nesting script means handling subscription sources, proxy-group names, duplicates, and script destinations yourself. Clash Verge Kit turns that work into a guided terminal flow and lets you review the result before anything is written.

The tool supports three tasks:

| Your task | What the tool provides |
| --- | --- |
| Use several subscriptions together | Add locally imported subscriptions or child HTTPS URLs as separate proxy groups inside the primary subscription |
| Choose an AI outlet | Reuse an existing group, or page, search and select nodes from the target and local child subscriptions; use routing independently or alongside nesting |
| Change the plan later | Reopen an authenticated saved plan to change its outlet, add or remove nodes, or disable AI routing |

All three flows share summaries, masked previews, copying and confirmed safe writes. Nodes retain their original names; writes check source changes and back up the original script.

## How to use it now

Requirements:

- Node.js 22.12.0 or later;
- Clash Verge Rev installed;
- a target subscription already imported into Clash Verge Rev.

Run these commands in a terminal:

```powershell
git clone https://github.com/Ch1ldr3n/clash-verge-kit.git
cd clash-verge-kit
npm.cmd ci
npm.cmd run cli
```

After installing the dependencies, Windows users can also double-click `clash-verge-kit.cmd` in the repository root. The first run builds the CLI; later runs reuse the existing build.

## Typical workflow

1. Choose the language, feature, and target subscription.
2. For AI routing, restore or create a plan, then reuse a group or select nodes. Nesting also requires a primary group and child subscriptions.
3. Page, filter, toggle nodes and add locally imported sources. If a provider has no readable cache, refresh it in Verge before retrying.
4. Review the AI outlet, candidate counts and missing sources for the current draft.
5. Copy the script, or confirm and write it to the target script file.
6. Return to Clash Verge Rev, reactivate the target subscription, and verify the result.

A successful write only means that the script file was updated. Clash Verge Kit does not restart or control Clash Verge Rev, and it does not treat “file written” as “configuration applied.”

Before a V3 write, Kit saves a `.kit-backup-<digest>` copy beside the original script. Restoring it also requires reactivation. Authenticated V1/V2 existing-group plans can migrate; legacy V1 cloned groups and unknown or modified scripts remain read-only. A copied but uninstalled script cannot be reopened automatically. Changed source locations or support capabilities require a new review and confirmation.

## Security and privacy

- unsaved drafts remain in the CLI process; saved scripts and local backups contain necessary source information and should be handled as sensitive files;
- the terminal never prints the complete script, and previews mask subscription sources;
- the tool does not modify `profiles.yaml`;
- it does not inspect a remote subscription or write a file without confirmation;
- unknown custom scripts, unsafe paths, symbolic links, Windows junctions, and concurrent changes are rejected;
- never publish real subscription URLs, tokens, `profiles.yaml`, raw YAML, or complete generated scripts in the repository, issues, screenshots, or logs.

See the [security policy](SECURITY.md) for the complete boundaries.

## Project status

The local CLI is currently the only supported entry point, and the repository has not published an npm package. Once an npm release exists, this README will document the one-command workflow that does not require cloning the repository. Until then, use the source-based instructions above.

Development and release checks:

```powershell
npm.cmd test
npm.cmd run check:release
# With a test Mihomo binary installed, run the full isolated acceptance suite:
npm.cmd run check:acceptance
```

See the [architecture guide](docs/architecture.md) for the feature-to-file map, and the [local usage guide](docs/deployment.md) and [verification guide](docs/verification.md) for setup and test requirements.

## License

[MIT License](LICENSE)
