# Changelog

All notable changes to MAUI Deploy are documented in this file.

## 1.6.1 - 2026-09-17

### Changed
- Generate PR links through Microsoft's HTTP redirect, retaining repository details in the fragment and adding a separate Pages fallback. Keep explicit self-hosted bridges and existing Pages links compatible.

### Fixed
- Preserve URI query separators when receiving PR links from VS Code, and validate the redirect callback without rejecting its fixed `url` parameter.
- Keep manual editor-opening and return-to-PR links available on the Pages fallback without automatic tab juggling or navigation away.

## 1.6.0 - 2026-09-17

### Added
- Add Deploy Branch with searchable local/remote branches and GitHub or GitHub Enterprise PR URLs, using a reusable detached worktree without changing the active checkout.
- Add shared project setup using native VS Code menus or the optional `mauideploy setup` terminal command. Always use Debug for branch/PR deployment, including older Release profiles, without configuration or PR permissions prompts. Fork PRs retain an explicit build confirmation.
- Open native setup menus automatically on first branch/PR use, select a matching local clone when needed, and resume the original PR after successful setup. Cancelled or failed setup never starts fetch or build.
- Require device selection before every branch/PR deployment, even with a single available target. Suggest the last used device without automatically selecting it, support choosing another platform and stop before building when selection is cancelled.
- Add PR URI handling and `mauideploy pr-link`, with a hosted HTTPS bridge and a manual GitHub Pages publishing workflow.
- Protect dirty worktrees, concurrent deployments, repository identity, fork PR execution, and fetched PR commit consistency; retain cancellation and ordinary Run/Debug selections.

### Fixed
- Accept GitHub Enterprise SSH remotes with custom usernames, preventing `Invalid URL` during branch/PR setup without changing Git authentication.
- Start Run build terminals in the selected project's directory, including branch worktrees, so SDK selection uses the correct `global.json`.

## 1.5.0 - 2026-09-14

### Added
- Add a macOS screenshot camera button and independent device picker, prioritizing the current deployment target without changing it.
- Capture PNG screenshots from physical iPhones through the native macOS tunnel, booted iOS simulators, and authorized Android devices/emulators without creating image files.
- Open screenshots in an in-memory VS Code preview and automatically copy the image to the macOS clipboard.
- Offer isolated, cancellable first-use installation of a versioned physical-iPhone helper and managed Python, without changing project or global Python dependencies.
- Add screenshot progress diagnostics and timeout messages without logging image contents, and retain the preview if clipboard copying fails.

## 1.4.3 - 2026-09-14

### Changed
- Make the physical iOS Debug dynamic registrar opt-in, retaining project registrar settings by default. Explicit opt-ins remain supported; returning from dynamic mode restores, cleans and rebuilds the selected target.

### Fixed
- Restore the selected framework, configuration, runtime and project references before registrar-triggered iOS clean, preventing NETSDK1047 after simulator/device or Test/Debug switches. Stop on restore failure and retain normal incremental builds when no clean is needed.
- Preserve command stdout/stderr when the MSBuild error log is missing or empty, including clean/restore failures and non-compiler errors in Build Errors and Copilot repair prompts.

## 1.4.2 - 2026-09-10

### Fixed
- Restore the iOS and Android Debug compatibility-analysis optimizations and settings that were missing from the 1.4.1 package.
- Restore dynamic registrar support for physical iOS Debug Run and Debug, including clean-on-switch handling and the project-settings fallback.
- Restore iOS build/deploy timings, optional binlogs, and awaited installation and launch with failure and cancellation handling.
- Retain the 1.4.1 incremental iOS restore fix for simulator and physical-device target changes, with regression coverage alongside the restored deployment tests.

## 1.4.1 - 2026-09-09

### Fixed
- Use normal incremental NuGet restore for iOS Run, Debug and pre-builds, preventing NETSDK1047 after switching between simulator and physical-device targets.

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
