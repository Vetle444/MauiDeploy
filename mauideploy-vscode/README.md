# MAUI Deploy

MAUI Deploy adds a compact VS Code toolbar for building, deploying, and debugging .NET MAUI apps on iOS and Android devices.

## Features

- Select a MAUI project from the current workspace
- Choose Debug or Release configuration from the status bar
- Pick iOS simulators, paired iOS devices, or Android devices
- Take device screenshots on macOS, open an in-memory preview, and automatically copy the image to the clipboard
- Build and deploy MAUI apps without leaving VS Code
- Deploy a branch or GitHub PR from a reusable, isolated worktree while an agent keeps working in your checkout
- Deploy MAUI apps from the existing `bin` output without rebuilding
- Debug MAUI apps with the bundled Mono SDB adapter and experimental XAML Hot Reload on save
- Start a Debug-only experimental `dotnet watch` rebuild/rerun watcher from the status bar
- Pick a `.csproj` from the toolbar and run it with `dotnet test`, using `-c Test` when the project declares a Test configuration
- Ask Copilot to fix captured build errors directly from the build failure notification
- Start a bundled Mono SDB debug adapter for C# debugging
- Open MAUI Deploy logs from the command palette

## Commands

- `MAUI Deploy: Run`
- `MAUI Deploy: Deploy Branch or PR`
- `MAUI Deploy: Set Up Branch Deployment`
- `MAUI Deploy: Deploy from Bin`
- `MAUI Deploy: Debug`
- `MAUI Deploy: Watch Run (Experimental)`
- `MAUI Deploy: Stop Watch Run`
- `MAUI Deploy: Run Tests`
- `MAUI Deploy: Select Project`
- `MAUI Deploy: Select Device`
- `MAUI Deploy: Take Screenshot`
- `MAUI Deploy: Toggle Configuration`
- `MAUI Deploy: Ask Copilot to Fix Build Error`
- `MAUI Deploy: Open Logs`

## Branch And PR Deployment

After installing or updating the extension, reload VS Code and open a **new
integrated terminal** in your MAUI application repository:

```sh
mauideploy setup
```

The command selects a Git remote, tracked MAUI project, Debug/Release configuration,
and device. Single project/device choices are automatic. These defaults are stored
locally per repository under `~/.mauideploy/branch-deploy/`, separately from ordinary
Run/Debug selections. No project files are changed. Run setup again to change them.
The command palette's **MAUI Deploy: Set Up Branch Deployment** opens this terminal
flow. The terminal command uses VS Code's bundled runtime; a global Node installation
is not required. It is available in new VS Code terminals, not globally in other shells.

Click **Deploy Branch** in the status bar, search for a branch, and press Enter.
Remote and local branches are distinguished, and the last selection appears first.
Local branches remain available when the remote is offline. You can also paste an
HTTPS GitHub or GitHub Enterprise PR URL. Every ordinary button click requires a
branch/PR selection; subsequent project, configuration, and device pickers are not
part of deployment. Missing projects or unavailable devices stop with an error instead
of silently selecting something else.

MauiDeploy creates a sibling `<repository>-mauideploy` worktree with detached HEAD
at the selected commit. It reuses that directory and ignored build output on later
deployments. Submodules are initialized from that commit. The original branch,
index, uncommitted files, `FETCH_HEAD`, and remote-tracking branches are preserved.
Local branch deployments include committed changes only. PR deployments use the
PR head, not GitHub's synthetic merge commit, and reject a PR that changes during fetch.
Build terminals run in the worktree project's directory so its `global.json` and
normal SDK discovery apply.

Only one MauiDeploy operation may use a repository's deployment worktree at a time,
including across VS Code windows. A dirty, repurposed, or unmanaged worktree is never
reset, cleaned, or overwritten. A crash can leave `mauideploy.lock` in the repository's
Git common directory; remove it only after confirming no deployment is still running.
Stop an active MAUI debug session before deploying another branch from that window.

Worktrees isolate normal source and `bin`/`obj` output, **not the device or app data**.
Deploying the same application ID replaces the installed app. Custom absolute output
paths and references outside the repository are not isolated by Git. Ignored local
configuration and signing files are not copied from the development checkout.

### One-Click PR Links

GitHub CLI (`gh`) must be installed and authenticated for the repository's host;
Git uses your existing remote credentials. PR links can deploy automatically only
after setup explicitly authorizes this for the repository. The workspace must be
trusted. Fork PRs and repositories without automatic authorization require a build
confirmation because restore/build can execute code locally.

Generate Markdown for a PR description or comment:

```sh
mauideploy pr-link https://github.com/owner/repository/pull/123
```

The link opens an HTTPS bridge that automatically invokes
`vscode://FinstadProductions.maui-deploy/deploy-pr`. MauiDeploy finds the configured
local repository and performs fetch, worktree preparation, build, install, and launch
without further picks for an authorized same-repository PR. The browser or OS may
still ask to open VS Code. A fallback link remains visible if automatic opening is
blocked. If multiple clones are configured for the same remote, you choose the clone.

**The default HTTPS bridge must be published before generated links work.** Its
source is in `docs/deploy/` in the MauiDeploy repository. Enable GitHub Pages with
**GitHub Actions** as the source, then manually run **Publish PR Deploy Link Page**.
This does not happen during extension installation. To host the static directory
elsewhere, pass `--bridge https://your-host/deploy/`. Add `--insiders` for VS Code Insiders.
Repository and PR identifiers are stored in the URL fragment, not sent as query
parameters to the bridge server; no tokens or local paths are included.

Until the bridge is published, paste an ordinary PR URL into the branch picker.
Branch/PR deployment currently targets local desktop VS Code with the normal MAUI
toolchain and device prerequisites; remote extension hosts have not been verified.

## Screenshots (macOS)

Click the camera in the status bar or run **MAUI Deploy: Take Screenshot**.
Choose an available phone or a running simulator/emulator. The current deployment
target appears first, but the screenshot selection does not change your Run/Debug
target. No build or active debugger is required.

The screenshot opens in a VS Code image tab and is automatically copied as an
image to the macOS clipboard. Screenshot bytes stay in memory: MAUI Deploy does
not create an image file in the project or temporary directory. Closing the tab
disposes its preview. The clipboard is not automatically cleared and may be
retained or synchronized by clipboard managers or macOS Universal Clipboard.
Capture and paste sensitive screens only where appropriate.

- **iOS Simulator:** uses Xcode's `simctl` and requires a booted simulator.
- **Android devices/emulators:** uses the Android SDK's `adb`; the device must
	be connected and authorized.
- **Physical iPhone:** uses the external `pymobiledevice3` helper and Apple's
	native macOS tunnel. The phone must be paired, reachable, and configured for
	development. Wi-Fi capture is verified on iPhone 15 Pro / iOS 26.6.1. Other
	iOS/macOS combinations and USB capture with this helper still need hardware
	verification.

The first physical-iPhone capture asks permission to install the helper. MAUI
Deploy uses Xcode's available `python3` to bootstrap `uv` 0.12.13, then installs
managed Python 3.14 and `pymobiledevice3` 11.12.5 under its VS Code global storage
directory. Internet access is required for setup. No global Python packages,
project dependencies, administrator access, or app agent are required. Later
captures reuse the verified installation. A cancelled or failed setup can be
retried by taking another screenshot. Helper metadata and package caches are
stored in this private directory, separate from the in-memory screenshot.

The helper is downloaded separately, not bundled in the VSIX:
[pymobiledevice3 source and GPL-3.0-or-later license](https://github.com/doronz88/pymobiledevice3),
[uv source and licenses](https://github.com/astral-sh/uv).
Screenshot capture/clipboard integration currently runs on a macOS extension
host; Windows, Linux, and remote-host screenshot workflows are not supported.

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

`mauideploy.ios.useDynamicRegistrar` defaults to `false`, retaining the project's
registrar settings. Opt in by setting it to `true`: both Run and Debug then use
`Registrar=dynamic` for physical iOS devices in Debug configuration, avoiding
static registrar native compilation. This overrides any explicit project registrar
setting and may cause startup crashes with incompatible registrar artifacts.
Release and simulator builds are unchanged.

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