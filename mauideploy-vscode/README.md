# MAUI Deploy

MAUI Deploy adds a compact VS Code toolbar for building, deploying, and debugging .NET MAUI apps on iOS and Android devices.

## Features

- Select a MAUI project from the current workspace
- Choose Debug or Release configuration from the status bar
- Pick iOS simulators, paired iOS devices, or Android devices
- Take device screenshots on macOS, open an in-memory preview, and automatically copy the image to the clipboard
- Record native device video on macOS, preview it, and save an H.264 `.mp4` file
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
- `MAUI Deploy: Record Video`
- `MAUI Deploy: Stop Recording`
- `MAUI Deploy: Cancel Recording`
- `MAUI Deploy: Save Recording`
- `MAUI Deploy: Toggle Configuration`
- `MAUI Deploy: Ask Copilot to Fix Build Error`
- `MAUI Deploy: Open Logs`

## Branch And PR Deployment

After installing or updating the extension, reload VS Code. The first **Deploy
Branch** click or PR link automatically opens VS Code's native selection menus if that repository
has no saved profile. For a PR link, MauiDeploy uses a matching open repository;
otherwise it asks you to select an existing local clone. Only remotes matching
the PR repository are available during that setup. It does not clone a repository
automatically.

Setup selects a Git remote and tracked MAUI project. Single remote/project choices
are automatic. All branch/PR builds use **Debug**; there is no configuration or PR
permissions menu. Previously saved Release and permission choices no longer affect
deployment. Cancelling any menu leaves the existing profile unchanged. After setup,
the original PR continues without another link click.

The project picker only lists projects inside the selected repository. A PR link
selects its repository; the toolbar and setup command start from the ordinary selected
project, or the open workspace folders when no project is selected. Projects in other
local clones are not included. Use a PR link for the intended repository or select
its project in the ordinary project picker before starting branch deployment.

**Choose a device before every branch or PR deployment**, including when only one
device is available. The picker lists compatible iOS and Android targets for the
selected branch. The last used device appears first, but always requires selection.
Cancelling the picker stops before build, install or launch and preserves the last
device. The project and last used device are remembered separately from ordinary
Run/Debug selections, including their Debug/Release setting, which are unchanged.

To configure ahead of time or change the saved settings, use **MAUI Deploy: Set Up
Branch Deployment** in the command palette. It opens the same native menus without
starting a deployment. As an optional terminal alternative, open a **new integrated
terminal** in your MAUI application repository and run:

```sh
mauideploy setup
```

Both setup interfaces use the same validation and store settings locally per
repository under `~/.mauideploy/branch-deploy/`. Neither setup asks for a device;
that choice belongs to each deployment. No project files are changed. The optional
terminal command uses VS Code's bundled runtime; a global Node installation is not
required. It is available in new VS Code terminals, not globally in other shells.

Click **Deploy Branch** in the status bar, search for a branch, and press Enter.
Remote and local branches are distinguished, and the last selection appears first.
Local branches remain available when the remote is offline. You can also paste an
HTTPS GitHub or GitHub Enterprise PR URL. Every ordinary button click requires a
branch/PR selection followed by a device selection. The project menu is only needed
during setup. Missing projects or no available compatible devices
stop with an error instead of silently selecting something else.

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

### Dependency Checks (macOS/iOS)

Branch/PR deployment checks prerequisites before the stage that needs them:

- Git before repository selection or worktree creation.
- GitHub CLI and sign-in to the PR's exact host before PR lookup/fetch. Local branch
	deployment does not require GitHub CLI. Git still uses its existing credentials.
- Full selected Xcode, completed first-use setup, `simctl`, `devicectl` and the iOS
	SDK before iOS device discovery. Missing Xcode does not force Android users to
	install it: a multi-platform project can continue with Android for that deployment.
- A .NET SDK resolved by `dotnet --version` from the **worktree project's directory**,
	followed by that SDK's installed MAUI iOS workloads, before any iOS build.

Missing prerequisites open a native menu with installation, setup instructions and
**Recheck** actions. Installation requires explicit confirmation. After installation
or a successful sign-in, the checks run again and the same deployment continues.
Closing the menu, declining installation or stopping the operation never starts a
build. Device selection remains mandatory for every deployment.

On macOS, missing Git or `gh` can be installed using existing Homebrew. Homebrew itself
is not installed automatically. GitHub sign-in runs in a dedicated user-operated
terminal; passwords, tokens and authentication output are not read into diagnostics.
The extension does not configure Git credentials or SSH keys.

Missing SDKs use Microsoft's official HTTPS `dotnet-install.sh` installer in private
extension storage (`prerequisites/dotnet/`). The requested version is installed beside
existing SDKs; when there is no pinned SDK, the target framework's SDK channel is used.
A staging installation must resolve successfully in the worktree before activation.
Neither `global.json`, the original repository, nor the system's .NET installation
or global PATH is rewritten. The selected executable is used explicitly for restore,
registrar clean and build. A private installed SDK takes priority on later deployments
for the same SDK requirement.

If MAUI iOS workloads are missing, MauiDeploy can install `maui-ios` with the selected
SDK using `--skip-manifest-update`. Administrator-managed SDKs offer a private copy
first instead of invoking `sudo`. Installations are serialized across VS Code windows;
cancellation stops the owned installer process group and removes incomplete SDK
staging. A crash may leave `prerequisites/install.lock`; remove it only after confirming
that no dependency installation is still running. Downloads can require substantial
disk space and network access. Existing managed SDK directories are not overwritten.

Xcode installation/selection, license acceptance, simulator runtimes, physical-device
pairing/Developer Mode, signing identities, private NuGet access and corporate network
requirements remain user-managed. The preflight checks basic Xcode readiness; exact
Xcode/workload-version compatibility and project-specific requirements are still
validated by the normal build. Ambiguous SDK configuration (for example custom SDK
search paths or a configuration file the installer cannot parse) gets manual guidance
instead of a guessed installation. No automatic SDK-policy or workload upgrade occurs.

This first preflight version covers macOS/iOS branch and PR deployment and native
branch setup. Ordinary Run/Debug and the optional terminal setup command retain their
existing behavior. Automatic Android JDK/SDK setup and remote extension hosts are not
covered. VS Code's bundled runtime runs the extension and CLI; users need no separate
Node/npm installation, C# Dev Kit or separately installed MauiDeploy debug adapter.

### PR Links

GitHub CLI (`gh`) must be installed and authenticated for the repository's host;
Git uses your existing remote credentials. The workspace must be trusted, and a device
must be selected for every deployment. Same-repository PRs need no additional build
confirmation. Fork PRs still require explicit confirmation because restore/build can
execute code locally. A worktree is not a security sandbox; only deploy code you trust.

Generate Markdown for a PR description or comment:

```sh
mauideploy pr-link https://github.com/owner/repository/pull/123
```

The command prints two Markdown links. **Test with MauiDeploy** uses Microsoft's
existing `https://vscode.dev/redirect` service, which responds with HTTP 302 directly
to VS Code instead of loading a launcher page. A manual Safari test confirmed that
the original PR tab remains visible when accepting or cancelling the editor-opening
prompt. The browser or OS can still require confirmation or block the protocol.
Other browsers and policies, and machines without VS Code, need separate verification.

**Problems opening?** opens the Pages fallback at
`https://vetle444.github.io/MauiDeploy/deploy/`. It retains a manual editor-opening
link and a **Tilbake til PR** link even if protocol opening is denied. Returning to
the PR requires one click and opens the PR in a new tab, preserving the fallback.
There is no automatic return, popup creation or timeout-based success detection.
The fallback itself is a regular web page and may replace the current tab; use
Cmd/Ctrl-click or middle-click to open it in another tab from the start.

New direct links require **MauiDeploy 1.6.1 or newer**. Old
Pages links remain accepted, but do not acquire the new tab-preserving behavior;
regenerate existing PR comments or their workflow with the new primary URL format.
For the direct link, the only query parameter sent to Microsoft is the fixed VS Code
extension target. Repo and PR identifiers stay in the fragment, which the browser
inherits on the redirect. The extension validates both the fixed target and the PR
parameters. No tokens or local paths are included, and no GHE access is granted to
the redirect service.

MauiDeploy finds the configured local repository, fetches the PR and prepares its
worktree. After you select a device, Debug build, install and launch proceed
automatically for a same-repository PR. If multiple clones are configured for the
same remote, you choose the clone. Setup and device selection remain in VS Code.

Application repositories do not need their own web service or Pages setup. The
fallback source is in `docs/deploy/`; maintainers update it with **Publish PR Deploy
Link Page**. To avoid the Microsoft redirect or use a self-hosted launcher, pass
`--bridge https://your-host/deploy/`: this explicitly retains the original single
Pages-style link, with no automatic new-tab guarantee. Add `--insiders` for VS Code
Insiders in either mode.

You can also paste an ordinary PR URL directly into the branch picker.
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

## Video Recordings (macOS)

Click the record icon beside the screenshot camera, or run **MAUI Deploy: Record
Video**, and choose a device. The selection does not change your Run/Debug target.
This uses native video capture, not repeated screenshots or GIF encoding.

A cancellable **MAUI Deploy: Record Video** notification appears immediately,
including while devices are being discovered. It reports helper setup, USB or
permission waits, capture startup, finalization, download, and saving. The status
bar shows the current phase even when the notification is hidden.

- **Physical iPhone:** connect by USB, unlock the phone, and trust this Mac.
	Wi-Fi alone is not sufficient for this recording backend. A small bundled Swift
	helper uses macOS AVFoundation and requests 30 FPS when the device supports it.
	Actual frame rate and resolution depend on the device. Xcode 15 or newer is
	required; the helper is compiled and cached in MAUI Deploy's private global
	storage on first use. No iPhone app, WebDriverAgent, Python helper, or additional
	downloads are required for video capture.
- **iOS simulator:** uses Xcode's `simctl recordVideo` with H.264 on a booted simulator.
- **Android device/emulator:** uses `adb shell screenrecord`, then pulls the MP4
	and removes the temporary device recording. Authorized wireless ADB connections
	also work; only physical-iPhone recording requires USB.

macOS may ask for camera access for VS Code or MAUI Deploy Screen Recorder.
Allow it in **System Settings > Privacy & Security > Camera** if needed. The
helper matches the selected iPhone's device identifier and never falls back to
the Mac camera or another phone. Audio is not recorded.

When the selected iPhone is not available over USB, **Waiting for USB** remains
visible for up to two minutes. Connect and unlock that phone and trust this Mac;
capture continues automatically when it becomes available. A separate **Camera
permission** state identifies a pending macOS access prompt. Neither state means
video is already being recorded. Click the busy status-bar item, cancel the
notification, or run **MAUI Deploy: Cancel Recording** to cancel preparation.

The button becomes a red Stop icon with an elapsed timer only after capture
starts. Click it again, or run
**MAUI Deploy: Stop Recording**, to finalize the MP4. Recordings stop automatically
after three minutes; local capture also has a 512 MiB size limit. Cancel in the
progress notification stops capture and discards the unfinished recording.

The video opens in a preview with playback controls, followed by a Save Video
dialog. Choose a destination for the `.mp4` file. Cancelling the save dialog keeps
the preview open. Use its Save icon or **MAUI Deploy: Save Recording** with the
preview active to save later or retry a failed save. Videos are not copied to the
clipboard. The screenshot button and its Wi-Fi/clipboard behavior are unchanged.
After a successful local save, Finder opens with the saved video selected. If
Finder cannot be opened, the video remains saved and a warning is shown.

Completion feedback distinguishes saved video, an unsaved preview, cancellation,
and failure. **MAUI Deploy - Recordings** in Output records stage changes and
errors without logging video content or raw device diagnostics.

Temporary video files live in a private directory under MAUI Deploy's global
storage until you close the preview. Cancellation and failed capture remove local
temporary files; saved copies remain at the destination you choose. Abruptly
terminating VS Code may leave temporary files behind. An Android disconnection
can prevent device-side cleanup; a warning identifies the temporary directory
to remove after reconnecting. Record and share sensitive screens only where
appropriate. Recording currently requires a local macOS extension host.

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