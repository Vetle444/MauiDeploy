# Changelog

All notable changes to MAUI Deploy are documented in this file.

## 1.4.0 - 2026-09-09

### Added
- Skip trimming and single-file compatibility analysis by default for iOS Debug Run and Debug, on simulators and physical devices. Set `mauideploy.ios.skipCompatibilityAnalyzers` to `false` to retain project settings. Release, source generators, and other analyzers are unchanged.
- Use the dynamic registrar by default for physical iOS Debug Run and Debug builds. Turn off `mauideploy.ios.useDynamicRegistrar` if the app crashes; first use and setting changes clean the matching output before rebuilding. Release and simulator builds are unchanged.
- Report iOS Run build, install, launch, and total timings, with optional local MSBuild binlogs.
- Skip trimming and single-file compatibility analysis by default for Android Debug, with an option to retain the project's analysis settings. Source generators and other analyzers remain enabled.
- Detect Android device architecture and build only the matching runtime in Debug.
- Use Android SDK incremental installation and Fast Deployment for both Run and Debug, with settings for full APK deployment and forced reinstall while preserving app data.
- Report Android build/restore, deploy, and launch timings; optionally save local MSBuild binlogs.
- Preserve Android build metadata for Deploy from Bin and reuse unchanged standalone APK installations after checking package identity.

### Fixed
- Wait for iOS installation and launch to complete, and propagate deployment failures and cancellation.
- Avoid duplicate APK installation when starting the debugger after SDK deployment.
- Use normal incremental NuGet restore for Android architecture changes and serialize multi-target builds of the same project to prevent shared restore-cache races.

## 1.3.3 - 2026-08-18

### Added
- Replaced running status-bar spinners with a stop button for the current Run, Run Multiple, Deploy from Bin, Debug, or Test operation.

### Fixed
- Reset stuck running state when a build terminal exits without writing its completion marker.

## 1.3.2 - 2026-08-12

### Fixed
- Preserved iOS simulator app data when redeploying by replacing the installed app instead of uninstalling it first.

## 1.3.1 - 2026-06-24

### Fixed
- Attached the physical iOS debug launch to the device console so app stdout and stderr are visible while debugging.

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
