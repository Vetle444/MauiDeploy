# DUI Memory

Local JSONL inspection for MAUI Deploy. Open **MAUI Deploy: DUI Memory Diagnostics**
from the command palette or **DUI memory diagnostics** in the MAUI Deploy sidebar.
The diagnostic view itself stays in the editor for more space.

In a trusted VS Code workspace, the command reads diagnostic files from the
selected project's app on the selected device and fills the panel automatically.
If no project or device is selected, the existing MAUI Deploy pickers open first.
It does not build, install, launch, boot or modify the app. The app must already
have completed a DUI GC check in Debug with `DUI.IsDebug` enabled.

iOS requires a local macOS host and an existing app bundle for the selected
configuration, whose bundle ID identifies the installed app. Physical iOS uses
`devicectl`; simulator import uses `simctl`. Android uses `adb run-as` with the
project's application ID and requires a debuggable installed app. Only supported
files inside `memory-diagnostics` are fetched. Automatic import is limited to
128 files, 16 MB per file and 64 MB per snapshot. Larger exports can be selected
manually.

Use **Refresh** beside Summary and Checks to reread the selected app/device's JSONL
files with one click. Opening diagnostics again also replaces the device snapshot.
Removed or rotated files do not remain from an older snapshot. Failures and
cancellation keep the last imported data; the Files menu identifies its app and
device. Closing the panel cancels its current read.

For standalone browser use, export JSONL files from the app sandbox first. Select or drop multiple local
copies together: `checks-*.jsonl`, their `.previous.jsonl` copies and the legacy
`checks.jsonl` / `checks.previous.jsonl` names are supported. A browser cannot read
the sandbox directly. All checks are combined chronologically without deduplication.
For manually imported files, **Refresh** opens the file picker so you can select
the updated JSONL exports directly. Reloading a source replaces only that filename;
the other sources stay loaded. No local file paths or access permissions are persisted.
Each event retains its filename and line number. Closing the panel or reloading
the page clears data.

The default Summary shows how many checks had survivors, a timeline and one row
per full root type, ranked by the number of checks with `alive: true`. Counts refer
to checks, not unique objects or proven leaks. Select a type to inspect its checks,
or open Checks for the full chronological list. Event details include survivor
types and GC rounds. There are no filter or interpretation controls in the view.
File tools live under the Files icon beside Refresh: import, reload, remove,
clear session and per-file skipped-line reports. A small indicator marks import
issues instead of a permanent file header. Per-check source references remain visible.
Invalid lines and unsupported schema versions are skipped and reported per file.

Check sequence shows the latest six checks, newest first. Each
point opens the original event, including its source file and line. This is not a
recorded user journey: timestamps describe completed GC checks, including manual
and repeated checks. The schema contains no navigation events or visit/session IDs.

## Interpretation And Privacy

- Supports schema version 1 from `GCCollectionMonitor` and the Memory-Leaks guide
  in Arena.Mobile_3. No app, collection or storage code is changed.
- A "zombie check" is `alive: true`: something survived GC, not necessarily the
  root and not a proven leak. Shared objects can survive intentionally.
- Repeated checks remain separate events. Matching root types do not identify
  the same object; there are no stable object IDs or retaining reference chains.
- `visual` includes handlers and effects without distinguishing them.
- Processing is in memory, with no upload, telemetry, content logging, persistent
  browser storage or extension-state persistence. Packaged assets are local;
  production CSP blocks network connections. Development HMR uses local Vite.
- Physical iOS extraction briefly uses a private temporary directory. It is removed
  after reading, failure or cancellation. Raw tool output is never shown in the UI.

## Development

From this directory, with Node.js 22.12+:

```sh
npm ci
npm run dev -- --host 127.0.0.1
npm test
npm run test:browser
npm run build
```

Browser tests use Playwright Chromium (`npx playwright install chromium` if needed),
start their own loopback preview server and use only synthetic fixtures/screenshots.
Build output goes to `../out/memory-inspector/` and `../out/toolbox/` for packaging
by the extension. The tools sidebar reuses this Vite setup and local dependencies;
its browser preview is at `/toolbox.html`. Device/command controls require VS Code.
Run `npm ci` here before packaging from the extension directory. No backend is needed.

From the extension directory, run `npm run test:memory:vscode` for an actual VS Code
desktop test. On macOS it uses the installed VS Code executable; set
`VSCODE_EXECUTABLE` for a different location. The test uses a temporary profile,
workspace and synthetic device-tool responses, never a real app or installed
extension profile. It exercises the toolbar project picker, tools sidebar, inline
progress without duplicate notifications, device picker, sandbox reader,
webview, repeated import, failure, cancellation and retry. Add
`-- --vsix /absolute/path/to/package.vsix` to install and test the packaged extension
inside that temporary profile. All test profiles and private extraction files are
removed afterward. Screenshots contain synthetic data only.

Real-device verification is separate: confirm a supported Debug app has generated
diagnostic files before testing. Never capture real app data in test screenshots,
traces or logs. Inspect counts and validation outcomes only. A successful synthetic
VS Code test does not establish that physical-device extraction succeeded.
