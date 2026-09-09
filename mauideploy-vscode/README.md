# MAUI Deploy

MAUI Deploy adds a compact VS Code toolbar for building, deploying, and debugging .NET MAUI apps on iOS and Android devices.

## Features

- Select a MAUI project from the current workspace
- Choose Debug or Release configuration from the status bar
- Pick iOS simulators, paired iOS devices, or Android devices
- Build and deploy MAUI apps without leaving VS Code
- Deploy MAUI apps from the existing `bin` output without rebuilding
- Debug MAUI apps with the bundled Mono SDB adapter and experimental XAML Hot Reload on save
- Start a Debug-only experimental `dotnet watch` rebuild/rerun watcher from the status bar
- Pick a `.csproj` from the toolbar and run it with `dotnet test`, using `-c Test` when the project declares a Test configuration
- Ask Copilot to fix captured build errors directly from the build failure notification
- Start a bundled Mono SDB debug adapter for C# debugging
- Open MAUI Deploy logs from the command palette

## Commands

- `MAUI Deploy: Run`
- `MAUI Deploy: Deploy from Bin`
- `MAUI Deploy: Debug`
- `MAUI Deploy: Watch Run (Experimental)`
- `MAUI Deploy: Stop Watch Run`
- `MAUI Deploy: Run Tests`
- `MAUI Deploy: Select Project`
- `MAUI Deploy: Select Device`
- `MAUI Deploy: Toggle Configuration`
- `MAUI Deploy: Ask Copilot to Fix Build Error`
- `MAUI Deploy: Open Logs`

## Android Build Performance

Debug Run and Debug detect the selected device ABI and build for one runtime
(for example, `android-arm64`). Unknown or unavailable ABIs retain the project's
architecture defaults. Release retains the project's architecture and optimization
settings. Android uses normal incremental NuGet restore, including when switching
architecture or returning from an iOS/Test build. Builds of the same project are
queued during Run Multiple to avoid concurrent writes to shared restore output.

Both Run and Debug use the Android SDK's `Install` target. Fast Deployment uploads
managed assemblies separately; the SDK tracks upload inputs and checks whether the
app was uninstalled. The debugger then launches that installation without installing
the APK a second time.

| Setting | Default | Purpose |
| --- | --- | --- |
| `mauideploy.android.fastDeployment` | `true` | Use separate assembly deployment in Debug. Set to `false` to build and deploy a self-contained APK instead. |
| `mauideploy.android.forceReinstall` | `false` | Force reinstallation while preserving app data. Turn off after troubleshooting. |
| `mauideploy.android.collectBinlogs` | `false` | Record local MSBuild binlogs for profiling. |
| `mauideploy.android.skipCompatibilityAnalyzers` | `true` | Skip trimming and single-file compatibility analysis for Android Debug Run and Debug builds. Set to `false` to retain the project's analysis settings. Keeps source generators and other analyzers. Release and builds outside MAUI Deploy are unchanged; keep compatibility checks enabled in CI. |

Deploy from Bin retains the APK's original build settings via a `.mauideploy.json`
sidecar. It uses the SDK upload target without restoring or compiling, and requires
the original intermediate output and referenced assemblies to remain available.
Missing or stale output requires a new Run/Debug build. Standalone APKs without
MauiDeploy metadata use `adb install -r`; identical successful installations are
reused within the current extension session after checking the installed package
path and install/update timestamps. APKs produced by another IDE with assemblies
excluded are not standalone and must first be built with MauiDeploy.

### Measure Changes

1. Open Output and select **MAUI Deploy - Android Performance**.
2. Enable `mauideploy.android.collectBinlogs` if target-level detail is needed.
3. Build once to warm the cache, then measure an unchanged rebuild and a rebuild
	after one C# edit, using the same device and configuration.
4. Compare build/restore, deployment, and launch separately. Debugger setup and
	launch duration are reported in the Debug Console. Launch timing ends when the
	launch command completes; it does not measure the first rendered screen.
5. Repeat with Fast Deployment disabled to compare against full APK deployment.
	Do not include the first build after changing deployment mode in steady-state
	comparisons.

Binlog paths appear in the performance output. Logs stay in the local temporary
directory until removed; even with project imports excluded they can contain
sensitive paths, properties, and task data. Inspect them before sharing. No device
speedup is guaranteed without measuring the actual project and hardware.

## iOS Build Performance

`mauideploy.ios.skipCompatibilityAnalyzers` defaults to `true`, matching Android.
Run and Debug skip trimming and single-file compatibility analysis for iOS Debug
builds on both simulators and physical devices. Source generators and other
analyzers remain enabled; this does not disable the linker or change trimming.
Set it to `false` to retain the project's analysis settings. Release and builds
outside MAUI Deploy are unchanged. Keep compatibility checks enabled in CI because
these warnings are deferred during local Debug builds.

`mauideploy.ios.useDynamicRegistrar` defaults to `true`. Both Run and Debug use
`Registrar=dynamic` for physical iOS devices in Debug configuration, avoiding
static registrar native compilation. This overrides any explicit project registrar
setting. Release and simulator builds are unchanged.

**Turn this setting off if the app crashes.** The next Run or Debug cleans and
rebuilds using the project's registrar settings. Deploy from Bin cannot apply the
change because it does not rebuild the app.

MAUI Deploy cleans the selected project's iOS Debug output on first use and when
switching this setting, to avoid mixing native and managed registrar artifacts.
The first build after a switch is therefore slower. App data on the device is not
deleted. Mode tracking is local to this machine's temporary directory; clearing it
causes another first-use clean. Builds outside MAUI Deploy are not tracked: clean
the matching iOS output when switching registrar modes through another IDE or CLI.

### Build And Deploy Timings

Run reports build/restore, installation, launch, and total elapsed time in
**MAUI Deploy - iOS Performance**, for both simulators and physical devices.
It waits for installation and launch to finish and reports failures instead of
claiming deployment succeeded immediately after the build. Deploy from Bin also
waits for these steps and reports installation and launch timings.

Enable `mauideploy.ios.collectBinlogs` (default `false`) to record local MSBuild
binlogs for Run and physical-device Debug builds. The output channel includes each log's path. Logs may contain
sensitive properties and paths; inspect them before sharing. A restore retry may
replace the binlog of the first attempt; the reported build time includes both.

Measure an unchanged Run and a Run after one C# edit on the same target, without
cleaning build output. Launch timing ends when the launch command completes, not
when the first screen renders. These measurements do not include debugger setup
and do not measure registrar-related runtime overhead or app compatibility.

## Requirements

- VS Code 1.85 or newer
- .NET SDK with MAUI workloads installed
- Xcode command line tools for iOS deployment
- Android SDK platform tools for Android deployment

## Source

https://github.com/Vetle444/MauiDeploy