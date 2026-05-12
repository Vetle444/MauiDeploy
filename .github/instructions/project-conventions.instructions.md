---
description: "Use when working on any part of the MauiDeploy project — building, debugging, deploying, or modifying the extension. Covers project structure, build conventions, and platform-specific patterns."
applyTo: "**"
---
# MauiDeploy Project Conventions

## Project Structure

Three components in one solution:

| Component | Path | Target | Purpose |
|-----------|------|--------|---------|
| Console CLI | `MauiDeploy/` | net10.0 | Interactive terminal deploy tool (Spectre.Console) |
| Debug Adapter | `MauiDeploy.Debugger/` | net9.0 | Mono SDB ↔ DAP bridge (shipped inside extension) |
| VS Code Extension | `mauideploy-vscode/` | TypeScript | Rider-like toolbar UI, device/project management |

## Architecture Decisions

- **Self-contained**: No dependency on external extensions (C# Dev Kit, DotNet.Meteor). The debug adapter bundles mono/debugger-libs as ProjectReferences from `lib/debugger-libs/`.
- **No bundler**: Extension uses plain `tsc` — no webpack/esbuild. Output goes to `out/`.
- **Debug adapter ships as dotnet tool**: Published to `mauideploy-vscode/out/debugger/` and invoked via `"runtime": "dotnet"` in package.json.

## Platform-Specific Build Flags

- **iOS debug**: `-p:MtouchDebug=true` (enables Mono SDB in the app)
- **Android debug**: `-p:EmbedAssembliesIntoApk=true`
- **iOS run**: plain `dotnet build`
- **Android run**: `dotnet build -t:Run /p:AdbTarget="-s SERIAL"`

## Device Detection

- **iOS simulators**: `xcrun simctl list devices --json` — filter by `isAvailable`, parse `com.apple.CoreSimulator.SimRuntime` runtimes
- **iOS physical devices**: `xcrun devicectl list devices --json-output -` — filter by `pairingState === 'paired'`
- **Android devices**: `adb devices -l` — parse `model:` field
- Devices are shown in QuickPick grouped by platform, sorted by state (Booted first) then runtime (newest first)

## Debug Adapter (Mono SDB)

- Base class: `DebugAdapterBase` from `Microsoft.VisualStudio.Shared.VSCodeDebugProtocol`
- SDB session: `SoftDebuggerSession` from `Mono.Debugging.Soft`
- iOS simulator: `SoftDebuggerConnectArgs` (app listens, debugger connects)
- iOS physical: `SoftDebuggerListenArgs` on `IPAddress.Any` (app connects back to debugger)
- Android: `SoftDebuggerListenArgs` (debugger listens, app connects)
- iOS simulator launch: `mlaunch --launchsim` with `--argument=-monodevelop-port` or `xcrun simctl launch` fallback
- iOS physical launch: `xcrun devicectl device install app` + `xcrun devicectl device process launch`
- Android launch: `adb install` → `adb forward` → `adb shell monkey`

## Build & Package Workflow

The extension runs from `~/.vscode/extensions/`, **not** from the workspace source. After any code change, you must rebuild, repackage, and reinstall:

```bash
# Build debug adapter
cd MauiDeploy.Debugger
dotnet publish -c Release -o ../mauideploy-vscode/out/debugger/

# Build extension
cd mauideploy-vscode
npx tsc -p ./

# Package
npx @vscode/vsce package --allow-missing-repository

# Install (required — VS Code loads from ~/.vscode/extensions/, not workspace)
code --install-extension mauideploy-*.vsix --force
```

After installing, reload VS Code: Cmd+Shift+P → "Developer: Reload Window".
