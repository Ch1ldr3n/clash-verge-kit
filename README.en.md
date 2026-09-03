# Clash Verge Kit

[简体中文](README.md) | [English](README.en.md)

Clash Verge Kit is a local command-line tool for [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev). It helps you organize multiple child subscriptions into separate proxy groups and safely add them to an existing primary subscription.

> Current status: this project has not been published to npm. Run it from source for now; there is no working one-command `npm` or `npx` installation yet.

## What problem does it solve?

Manually writing a nesting script means handling subscription sources, proxy-group names, duplicates, and script destinations yourself. Clash Verge Kit turns that work into a guided terminal flow and lets you review the result before anything is written.

It currently supports:

- discovering subscriptions already imported into Clash Verge Rev;
- selecting the target subscription and primary proxy group;
- adding local child subscriptions or public HTTPS subscription URLs;
- generating a separate proxy group for each child subscription;
- reviewing a summary and a script preview with sensitive sources masked;
- copying the complete script to the clipboard;
- safely writing the script to the file already bound to the target subscription, after confirmation.

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

1. Choose the interface language and target subscription.
2. Select the primary proxy group that will receive the child groups.
3. Add one or more child subscriptions.
4. Review the subscription-to-group mapping.
5. Copy the script, or confirm and write it to the target script file.
6. Return to Clash Verge Rev, reactivate the target subscription, and verify the result.

A successful write only means that the script file was updated. Clash Verge Kit does not restart or control Clash Verge Rev, and it does not treat “file written” as “configuration applied.”

## Security and privacy

- Subscription sources and generated output remain in the current CLI process;
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
```

For technical details, see the [local usage guide](docs/deployment.md) and [verification guide](docs/verification.md).

## License

[MIT License](LICENSE)
