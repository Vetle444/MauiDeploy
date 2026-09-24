# MAUI Deploy

MAUI Deploy adds a local tools sidebar for building, deploying, debugging and inspecting .NET MAUI apps on iOS and Android devices. The status bar keeps Run, the project picker, the device picker and one MAUI Deploy button.

## Tools Sidebar

Click the **MAUI Deploy** activity-bar icon or status-bar button, or run
**MAUI Deploy: Open Tools**. Tools open in the sidebar rather than an editor tab.
The webview follows the VS Code theme and groups existing commands into Build &
Deploy, Device & Capture, Inspect and Workspace. Project, device and Debug/Release
configuration are at the top; Run, project and device selection also remain in the status bar.

Build progress, recording state and live-preview state are synchronized with the
extension. The Run position becomes Stop during a build, deployment or test;
the sidebar also offers Stop. Recording and live preview have their own stop
controls. Hiding the sidebar does not stop work or discard diagnostic panels.
All commands remain available from the command palette. Device previews,
screenshots and diagnostics open in their existing dedicated views.

Operations started while the sidebar is visible show progress and cancellation
there instead of a duplicate VS Code progress notification. If the sidebar is
hidden when an operation starts, native progress remains available. Project,
device, branch/PR, test, capture and setup choices open inside the sidebar, with
search, keyboard navigation and multiple selection where needed. Status-bar and
command-palette choices open the same sidebar. File browse/save dialogs, errors
and consent confirmations remain native.

The tools sidebar loads only bundled local assets. It has no telemetry or network
access; actions delegate to the existing commands, which may access devices, Git
remotes or build services as before. Workspace trust and existing confirmations
still apply.

## Features

- Select a MAUI project from the current workspace
- Choose Debug or Release configuration in the tools sidebar
- Pick iOS simulators, paired iOS devices, or Android devices
- Take device screenshots on macOS, open an in-memory preview, and automatically copy the image to the clipboard
- Record silent MP4 video and open a live device preview on macOS
- Inspect DUI GC checks from the selected app/device or exported files, with a compact summary, timeline, direct refresh and event details
- Build and deploy MAUI apps without leaving VS Code
- Deploy a branch or GitHub/GitHub Enterprise PR in an isolated worktree without changing your checkout
- Deploy MAUI apps from the existing `bin` output without rebuilding
- Debug MAUI apps with the bundled Mono SDB adapter and experimental XAML Hot Reload on save
- Pick a `.csproj` from Run Tests and run it with `dotnet test`, using `-c Test` when the project declares a Test configuration
- Ask Copilot to fix captured build errors directly from the build failure notification
- Start a bundled Mono SDB debug adapter for C# debugging
- Open MAUI Deploy logs from the command palette

## Commands

- `MAUI Deploy: Open Tools`
- `MAUI Deploy: Run`
- `MAUI Deploy: Deploy Branch or PR`
- `MAUI Deploy: Set Up Branch Deployment`
- `MAUI Deploy: Run Multiple Targets`
- `MAUI Deploy: Deploy from Bin`
- `MAUI Deploy: Debug`
- `MAUI Deploy: Run Tests`
- `MAUI Deploy: Select Project`
- `MAUI Deploy: Select Device`
- `MAUI Deploy: Take Screenshot`
- `MAUI Deploy: Record Video`
- `MAUI Deploy: Stop Recording`
- `MAUI Deploy: Cancel Recording`
- `MAUI Deploy: Save Recording`
- `MAUI Deploy: Live Device Preview`
- `MAUI Deploy: Stop Live Device Preview`
- `MAUI Deploy: DUI Memory Diagnostics`
- `MAUI Deploy: Toggle Configuration`
- `MAUI Deploy: Ask Copilot to Fix Build Error`
- `MAUI Deploy: Open Output`
- `MAUI Deploy: Open Terminal`
- `MAUI Deploy: Settings`

## DUI Memory Diagnostics

Open **DUI memory diagnostics** in the tools sidebar or **MAUI Deploy: DUI Memory Diagnostics** in the command palette.
In a trusted workspace, the panel automatically reads existing diagnostics from
the selected project and device. The app must have generated DUI GC checks in
Debug; the importer does not build or modify it. iOS uses Xcode tools and the
selected build's app ID; Android uses `adb run-as`. Use **Refresh** beside Summary
and Checks to reread the selected app/device's JSONL files with one click.

Manual import remains available under Files: export `checks-*.jsonl`, their
`.previous.jsonl` copies or legacy `checks.jsonl` / `checks.previous.jsonl` from
the sandbox, then select or drop them together. Manual reload replaces only that
filename; device reload replaces the whole snapshot. Invalid lines and unknown
schema versions are counted and skipped; repeated checks remain separate events.
For manually imported files, **Refresh** opens the file picker for updated exports.

`alive: true` means something survived GC, not a proven leak. The format has no
stable object IDs or reference chains. Processing stays in memory with no upload,
telemetry or permanent storage. Temporary physical-iOS copies are removed after
reading or cancellation. Closing the panel clears its session.
See [the development guide](https://github.com/Vetle444/MauiDeploy/blob/main/mauideploy-vscode/memory-inspector/README.md) for the standalone browser
view, tests and packaging instructions.

## Screenshots (macOS)

Click **Take screenshot** in the tools sidebar or run **MAUI Deploy: Take Screenshot**.
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
- **Physical iPhone:** uses the external `pymobiledevice3` helper. USB uses
	automatic connection selection so it can fall back when Apple's native tunnel
	is unavailable; Wi-Fi retains native macOS tunnel discovery. The phone must be
	paired, reachable and configured for development. Wi-Fi and USB PNG capture
	have been verified on a physical iPhone; other iOS/macOS combinations still
	need hardware verification.

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

## Video Recordings (macOS)

Choose **Record video** in the tools sidebar or run **MAUI Deploy: Record Video**.
Device selection is independent of your Run/Debug target. Progress appears in the
visible sidebar, with native progress available when the sidebar starts hidden.
Helper setup, USB/permission waits, recording time, finalization and saving have
separate states. Only the recording state means capture has started.

- **Physical iPhone:** requires USB, a paired and unlocked phone, and Xcode 15+.
	A bundled Swift AVFoundation helper is compiled into private extension storage
	on first use. It requests 30 FPS when supported; actual frame rate depends on
	the device. No Python helper, on-device app or encoder download is needed.
- **iOS simulator:** uses `simctl recordVideo` with H.264 on a booted simulator.
- **Android device/emulator:** uses `adb shell screenrecord`, downloads the MP4,
	then removes the temporary device recording. Authorized wireless ADB is supported.

macOS may request camera access for VS Code or MAUI Deploy Screen Recorder. The
helper uses USB screen sources, never the Mac camera. With one verified wired
iPhone and one screen source, selection is automatic; ambiguous connections open
a **USB Screen** choice in the sidebar. Discovery and recording use the same
native process. USB and camera-permission waits remain cancellable.

**Stop recording** finalizes the MP4; **Cancel Recording** discards the capture.
Recordings are silent and stop automatically after three minutes, with a 512 MiB
local size limit. The MP4 opens in a playback tab followed by a Save Video dialog.
Declining the save leaves the preview available. Its Save action, or **MAUI Deploy:
Save Recording**, retries later. Successful local saves reveal the file in Finder;
a Finder failure does not delete the saved video. Videos are not copied to the clipboard.

Closing the preview removes its private temporary video. Failed or cancelled
captures are cleaned up; saved copies remain where you chose. An Android
disconnection can prevent device-side cleanup and produces a warning. Abruptly
terminating VS Code can leave temporary files behind. **MAUI Deploy - Recordings**
in Output reports stages and errors without logging video contents.

## Live Device Preview (macOS)

Choose **Live device preview** in the tools sidebar. The preview opens separately;
select that window in your meeting app to share it. MauiDeploy does not broadcast,
upload or start a meeting. Previewing alone saves no files and captures no audio.

- **Physical iPhone:** uses native USB capture and the same screen selection and
	camera permission as recording. On macOS 26+ with Xcode 26+, the native window
	uses SwiftUI Liquid Glass controls; older systems use native fallback controls.
	Screenshot, record/stop and pause/resume stay outside device pixels. The window
	fits the device aspect ratio on startup and rotation. A disconnection clears the
	image; reconnect and start a new preview to resume.
- **Android:** requires [scrcpy 3+](https://github.com/Genymobile/scrcpy) and
	authorized USB or wireless ADB. If needed, MauiDeploy offers Homebrew installation
	or upgrade with explicit consent, validates the result and resumes the preview.
	Homebrew itself is not installed automatically. The view-only window disables
	audio, device control and clipboard synchronization. Native scrcpy shortcuts include
	Cmd+F for fullscreen, Cmd+Z to freeze and Cmd+Shift+Z to resume.
- **iOS simulator:** brings the selected booted Simulator forward. Stopping does
	not shut down the simulator or close other Simulator windows.

The sidebar shows live/paused/disconnected state and a stop action. Closing the
native window or stopping the preview ends only the helper MauiDeploy started.
Reloading or closing the extension also stops owned previews.
`mauideploy.livePreview.alwaysOnTop` defaults to `false`; it affects physical-device
preview windows, not Simulator. There is no in-window pin or fullscreen control.

The iPhone window's camera captures the displayed or paused frame into the existing
VS Code preview/clipboard flow. Record creates an explicit silent clip without
closing the live stream; Stop uses the existing MP4 preview/save flow. Closing the
window before finalization discards that unfinished clip. Starting a separate
recording from the sidebar asks before closing an active preview.

These are local macOS workflows; remote-host capture is not supported. Device
notifications appear in previews and recordings, so consider Focus mode for demos.
USB iPhone preview startup, screenshots and short standalone MP4 recording have
been verified on hardware. Sustained streaming, in-window clips, meeting-app sharing
and wireless-ADB streaming still need broader hardware validation.

## Branch And PR Deployment

Choose **Deploy branch or PR** in the sidebar or command palette. On first use,
select a Git remote and MAUI project; **Set Up Branch Deployment** changes that
setup later. Search local/remote branches or paste a GitHub/GitHub Enterprise PR
URL. Setup and selection take place in the sidebar. Every deployment asks for a
target device, even when only one is connected, and remembers the last choice.
Branch/PR deployment always uses Debug and does not change ordinary Run selections.

MauiDeploy reuses a detached sibling worktree named `<repository>-mauideploy`.
Your active checkout, branch and uncommitted edits stay untouched. The deployment
worktree must be clean and owned by MauiDeploy; dirty or unmanaged directories are
never overwritten. Missing managed, detached, unlocked worktrees can be recreated.
Locked or moved worktrees require repair rather than automatic pruning. A repository
lock prevents concurrent deployments. Before removing a stale deployment lock,
stop every related build/deployment and remove only the lock named in the error.

Workspace trust is required. Fork PRs require explicit consent to build untrusted
code. GitHub CLI authentication is checked for the remote's specific host. The
fetched PR commit must still match the inspected head; cancellation, failed setup
or a changed PR prevents deployment.

### Prerequisites

Before branch/PR deployment, MauiDeploy checks Git, host-specific `gh` sign-in,
selected Xcode readiness, and the project's .NET SDK and MAUI iOS workloads.
Consent-based setup can install supported tools through existing Homebrew or
prepare a private side-by-side SDK under extension storage. It does not change
`global.json`, system SDKs or global PATH, run automatic administrator commands,
or install Homebrew. Sign-in remains in a user-operated terminal. Successful setup
rechecks requirements and resumes the same request.

The selected worktree's SDK resolver is authoritative. Ambiguous SDK policy,
signing and private feeds require manual configuration. This preflight covers
local macOS/iOS branch deployment; automatic Android JDK/SDK setup and remote
extension hosts are not included. Ordinary Run/Debug keep their existing behavior.

### PR Links And Optional CLI

The bundled `cli/mauideploy` launcher supports `setup` and `pr-link`; use
`cli/mauideploy.cmd` on Windows. Run it from the application repository:

```sh
mauideploy setup
mauideploy pr-link https://github.com/owner/repository/pull/42
```

PR links use Microsoft's VS Code redirect, keep repository details in the URL
fragment, and include a separate GitHub Pages fallback. The fallback has explicit
Open in VS Code and return-to-PR links. `--insiders` selects VS Code Insiders;
`--bridge` retains support for a self-hosted bridge. Opening a link still requires
matching repository setup, workspace trust and device selection before deployment.

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