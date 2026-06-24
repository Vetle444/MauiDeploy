# Changelog

All notable changes to MAUI Deploy are documented in this file.

## 1.3.0 - 2026-06-24

### Added
- Added `MAUI Deploy: Run Multiple Targets` to build and deploy to selected iOS and Android targets concurrently.

### Changed
- Smoothed build progress reporting so the status bar no longer jumps to a high percentage early and then crawls near the end.

## 1.2.0 - 2026-06-03

### Fixed
- Restored the static VS Code debug adapter manifest fallback for `mauideploy`, so debugging can still start via `dotnet ./out/debugger/MauiDeploy.Debugger.dll` if extension activation is delayed or stale extension folders confuse the extension host.

### Changed
- Added explicit debug activation for MauiDeploy debug sessions and kept the extension identity stable as `FinstadProductions.maui-deploy`.

## 1.1.0 - 2026-06-02

### Highlights
- Faster repeat builds and smoother Run/Debug switching
- More reliable debugging on iOS simulators, physical iOS devices, and Android devices
- Better XAML Hot Reload for source-generated XAML, Shell, modals, templates, and bottom sheets
- New `MAUI Deploy: Clean bin/obj` command for clearing stale build output

### Changed
- Builds now skip NuGet restore when safe and retry with restore automatically when needed
- Hot Reload build inputs are stable and limited to the selected startup project, reducing unnecessary rebuilds
- XAML Hot Reload now uses port `55438` by default, supports `xamlHotReloadPort`, and cleans up stale tunnels before debugging
- Physical iOS Debug builds, app bundle selection, debug adapter startup, and cancellation handling are more reliable

### Fixed
- Fixed iOS simulator debugging on .NET 10, including launch timing and unexpected debugger disconnects
- Fixed Android and physical iOS debugger attach reliability
- Fixed breakpoint setup so VS Code can configure and verify breakpoints more consistently
- Fixed several XAML Hot Reload issues around path matching, `x:Name`, `NameScope`, toolbar/menu items, resources, behaviors, triggers, styles, and layout refresh
- Fixed launcher hang risk from stderr buffering, iOS SDK pack sorting for `net10.0`, and clearer Android APK install progress

### Removed
- Removed the old `MAUI Deploy: Open Logs` command, status bar button, and post-deploy `Open Logs` action

## 1.0.0 - 2026-05-22

### Added
- XAML Hot Reload with fast-path attribute patching and tunnel diagnostics
- Run Tests button (`dotnet test` integration)
- Build progress bar driven by MSBuild log output
- Auto-install missing tools via Homebrew

### Changed
- Per-workspace state persistence
- Device caching with background polling
- UX overhaul: clean terminal output, rich tooltips, error flash

### Fixed
- Fixed Android debug port forwarding and iOS simulator debug host

## 0.3.0 - 2026-05-15

### Added

- Added `MAUI Deploy: Deploy from Bin` and a dedicated status bar button for installing and launching existing `.app` or `.apk` artifacts without rebuilding.
- Added `MAUI Deploy: Ask Copilot to Fix Build Error`, including a build failure notification action that opens Copilot Chat with the captured MSBuild command, exit code, and errors.
- Added a dedicated build errors output channel that summarizes compiler errors from failed builds.

### Changed

- Improved status bar tooltips so VS Code theme icons render correctly.
- Simplified device detection progress text to avoid duplicate spinner glyphs.

### Fixed

- Removed literal codicon text such as `$(check)` from notification popups.
