# Changelog

All notable changes to MAUI Deploy are documented in this file.

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
