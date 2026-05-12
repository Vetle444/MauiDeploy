---
description: "Use when editing the VS Code extension TypeScript code in mauideploy-vscode/. Covers extension patterns, status bar management, and terminal integration."
applyTo: "mauideploy-vscode/**/*.ts"
---
# VS Code Extension Patterns

## File Organization

| File | Responsibility |
|------|---------------|
| `extension.ts` | Activation, status bar, commands, state management |
| `devices.ts` | Platform/device detection, simulator management, app bundle helpers |
| `deployer.ts` | Build terminals, build commands, log viewer |
| `projects.ts` | Workspace scanning, .csproj discovery |

## Conventions

- **Status bar priority**: Run(101) > Debug(100) > Project(99) > Config(98) > Device(97) > Logs(96)
- **State**: Persisted via `ExtensionContext.globalState` with key `mauideploy.state`. Includes projectPath, config, deviceId/Name/Platform, recentDevices.
- **Terminals**: Managed via `getBuildTerminal()` / `getLogTerminal()` helpers. Reuse existing terminal if not exited.
- **Error handling**: Swallow errors in device detection (`catch { }`) — missing `xcrun`/`adb` means that platform is unavailable, not an error.
- **QuickPicks**: Use separators for grouping, `$(icon)` prefixed labels, `matchOnDescription: true`.

## Important Patterns

- `isBuilding` gate prevents concurrent build/deploy/debug operations
- `updateStatusBar()` is the single source of truth for all status bar items — call after any state change
- Device picker shows recently used devices first, then groups by platform
- Config toggle is binary: Debug ↔ Release (no picker needed)
- iOS simulators auto-boot via `xcrun simctl boot` before deploy if state is Shutdown
