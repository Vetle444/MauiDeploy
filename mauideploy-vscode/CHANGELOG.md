# Changelog

All notable changes to MAUI Deploy are documented in this file.

## Unreleased

### Added

- Added experimental XAML Hot Reload to the Debug button. Debug builds now inject a small temporary helper via MSBuild, watch project `.xaml` files during the `mauideploy` debug session, and send changed XAML to the running app through the debug adapter.
- Added `MAUI Deploy: Watch Run (Experimental)`, a Debug-only `dotnet watch` rebuild/rerun flow with a dedicated status bar button and stop command.
- Added `MAUI Deploy: Run Tests` and a dedicated status bar button that lets you pick a `.csproj` to run with `dotnet test`, using `-c Test` when the selected project declares a Test configuration.

### Changed

- Restored the Debug button to the connected Mono SDB debugger. Watch Run remains separate because `dotnet watch build -t:Run` doesn't attach the debugger and did not provide reliable XAML Hot Reload in testing.

### Fixed

- Fixed Hot Reload build arguments so the watched build uses MSBuild properties instead of raw `-f/-c` switches that `dotnet watch` can pass directly to MSBuild.
- Fixed Hot Reload watcher scoping so the selected framework/configuration are passed as MSBuild properties instead of raw `dotnet watch -f/-c` switches that can leak into internal restore commands.
- Fixed Hot Reload delimiter placement so `dotnet watch` executes the watched `build` command instead of passing build arguments to the launched app.
- Fixed iOS Hot Reload startup so `dotnet watch` receives the selected device during its pre-run evaluation instead of invoking `mlaunch --installdev` without `--devname`.
- Fixed Hot Reload so `dotnet watch` is scoped to the selected target framework instead of evaluating every platform target in a multi-target MAUI project.
- Fixed Hot Reload command generation so MSBuild `-p:` properties are passed to `dotnet build` instead of being parsed by `dotnet watch`.

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