using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Spectre.Console;

// ── Log viewer mode ──
if (args.Length >= 4 && args[0] == "--log")
{
    await RunLogViewer(args[1], args[2], args[3]);
    return;
}

var settingsPath = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
    ".mauideploy", "settings.json");

var settings = Settings.Load(settingsPath);

AnsiConsole.Write(new Rule("[purple bold]MAUI Deploy[/]").RuleStyle("grey"));
AnsiConsole.WriteLine();

// Remembered state for quick rebuild
string? lastProject = null;
Platform? lastPlatform = null;
Device? lastDevice = null;
string lastConfig = "Debug";
bool? wantsLogging = null; // null = not asked yet, true/false = user's choice

while (true)
{
    // ── Quick rebuild shortcut ──
    if (lastProject is not null && lastPlatform is not null && lastDevice is not null)
    {
        AnsiConsole.MarkupLine($"[grey]Last:[/] [cyan]{Path.GetFileNameWithoutExtension(lastProject)}[/] → [cyan]{lastPlatform.Display}[/] → [cyan]{lastDevice.Display}[/] ([cyan]{lastConfig}[/])");
        AnsiConsole.WriteLine();

        var action = AnsiConsole.Prompt(
            new SelectionPrompt<string>()
                .Title("What to do?")
                .HighlightStyle(new Style(Color.Cyan1))
                .AddChoices(
                    "🔄  Rebuild & deploy (same settings)",
                    "📱  Change device",
                    "🔀  Change platform",
                    "📂  Change project",
                    "⚙️   Change configuration",
                    "🚪  Exit"));

        switch (action[0..2])
        {
            case "🔄":
                break; // use all last* values
            case "📱":
                lastDevice = null;
                break;
            case "🔀":
                lastPlatform = null;
                lastDevice = null;
                break;
            case "📂":
                lastProject = null;
                lastPlatform = null;
                lastDevice = null;
                break;
            case "⚙️":
                lastConfig = AnsiConsole.Prompt(
                    new SelectionPrompt<string>()
                        .Title("Select [green]configuration[/]:")
                        .AddChoices("Debug", "Release"));
                break;
            case "🚪":
                return;
        }
    }

    // ── Step 1: Project ──
    if (lastProject is null)
    {
        lastProject = SelectProject(settings, settingsPath);
        if (lastProject is null) continue;
    }

    // ── Step 2: Platform ──
    if (lastPlatform is null)
    {
        var platforms = DetectPlatforms(lastProject);
        if (platforms.Count == 0)
        {
            AnsiConsole.MarkupLine("[red]No iOS or Android target frameworks found in project.[/]");
            lastProject = null;
            continue;
        }
        lastPlatform = platforms.Count == 1
            ? platforms[0]
            : AnsiConsole.Prompt(
                new SelectionPrompt<Platform>()
                    .Title("Select [green]platform[/]:")
                    .UseConverter(p => p.Display)
                    .AddChoices(platforms));
        AnsiConsole.MarkupLine($"  Platform: [cyan]{lastPlatform.Display}[/]");
    }

    // ── Step 3: Device ──
    if (lastDevice is null)
    {
        List<Device> devices = [];
        await AnsiConsole.Status()
            .Spinner(Spinner.Known.Dots)
            .StartAsync("Detecting devices...", async _ =>
            {
                devices = await DetectDevices(lastPlatform);
            });

        if (devices.Count == 0)
        {
            AnsiConsole.MarkupLine($"[red]No booted/connected {lastPlatform.Name} devices found.[/]");
            if (lastPlatform.Name == "iOS")
                AnsiConsole.MarkupLine("[grey]Start a simulator via Xcode or: xcrun simctl boot \"iPhone 16\"[/]");
            else
                AnsiConsole.MarkupLine("[grey]Connect a device or start an emulator from Android Studio.[/]");
            lastPlatform = null;
            continue;
        }

        lastDevice = devices.Count == 1
            ? devices[0]
            : AnsiConsole.Prompt(
                new SelectionPrompt<Device>()
                    .Title("Select [green]device[/]:")
                    .UseConverter(d => d.Display)
                    .AddChoices(devices));
        AnsiConsole.MarkupLine($"  Device: [cyan]{lastDevice.Display}[/]");
    }

    // ── Step 4: First run — pick config ──
    if (lastProject is not null && lastPlatform is not null && lastDevice is not null
        && wantsLogging is null && lastConfig == "Debug")
    {
        // Only prompt config on first run, afterwards use the action menu
        var configChoices = new List<string> { "Debug", "Release" };
        if (lastConfig != configChoices[0])
            configChoices.Reverse();
        lastConfig = AnsiConsole.Prompt(
            new SelectionPrompt<string>()
                .Title("Select [green]configuration[/]:")
                .AddChoices(configChoices));
    }

    AnsiConsole.WriteLine();

    // ── Step 5: Build & Deploy ──
    if (lastPlatform!.Name == "iOS")
    {
        // iOS: build separately, then install + launch via xcrun simctl
        var iosBuildArgs = $"build \"{lastProject!}\" -f {lastPlatform.Framework} -c {lastConfig}";
        AnsiConsole.MarkupLine($"[grey]$ dotnet {iosBuildArgs}[/]");
        AnsiConsole.WriteLine();

        var exitCode = await RunInteractiveAsync("dotnet", iosBuildArgs);
        AnsiConsole.WriteLine();

        if (exitCode != 0)
        {
            AnsiConsole.MarkupLine("[red bold]Build failed.[/]");
        }
        else
        {
            // Find the .app bundle
            var appPath = FindIosAppBundle(lastProject!, lastPlatform.Framework, lastConfig);
            if (appPath is null)
            {
                AnsiConsole.MarkupLine("[red]Could not find .app bundle in build output.[/]");
            }
            else
            {
                // Install
                AnsiConsole.MarkupLine($"[grey]$ xcrun simctl install {lastDevice!.Id} \"{appPath}\"[/]");
                var installExit = await RunInteractiveAsync("xcrun", $"simctl install {lastDevice.Id} \"{appPath}\"");
                if (installExit != 0)
                {
                    AnsiConsole.MarkupLine("[red bold]Install failed.[/]");
                }
                else
                {
                    // Get bundle ID and launch
                    var bundleId = GetBundleId(appPath);
                    if (bundleId is null)
                    {
                        AnsiConsole.MarkupLine("[red]Could not determine bundle ID.[/]");
                    }
                    else
                    {
                        // Terminate any existing instance first (ignore errors)
                        await RunCaptureAsync("xcrun", $"simctl terminate {lastDevice.Id} {bundleId}");

                        AnsiConsole.MarkupLine($"[grey]$ xcrun simctl launch {lastDevice.Id} {bundleId}[/]");
                        var launchExit = await RunInteractiveAsync("xcrun", $"simctl launch {lastDevice.Id} {bundleId}");

                        AnsiConsole.WriteLine();
                        if (launchExit != 0)
                            AnsiConsole.MarkupLine("[red bold]Launch failed.[/]");
                        else
                            AnsiConsole.MarkupLine("[green bold]Deploy succeeded![/]");

                        // Logging
                        if (launchExit == 0)
                        {
                            if (wantsLogging is null)
                                wantsLogging = AnsiConsole.Confirm("Open [green]log viewer[/]?", defaultValue: true);
                            if (wantsLogging == true)
                                OpenLogTerminal(lastPlatform, lastDevice!, lastProject!);
                        }
                    }
                }
            }
        }
    }
    else
    {
        // Android: dotnet build -t:Run exits after deploy
        var buildArgs = BuildArgs(lastProject!, lastPlatform, lastDevice!, lastConfig);
        AnsiConsole.MarkupLine($"[grey]$ dotnet {buildArgs}[/]");
        AnsiConsole.WriteLine();

        var exitCode = await RunInteractiveAsync("dotnet", buildArgs);

        AnsiConsole.WriteLine();
        if (exitCode != 0)
            AnsiConsole.MarkupLine("[red bold]Build failed.[/]");
        else
            AnsiConsole.MarkupLine("[green bold]Deploy succeeded![/]");

        // Logging
        if (exitCode == 0)
        {
            if (wantsLogging is null)
                wantsLogging = AnsiConsole.Confirm("Open a [green]log viewer[/]?", defaultValue: true);
            if (wantsLogging == true)
                OpenLogTerminal(lastPlatform, lastDevice!, lastProject!);
        }
    }

    AnsiConsole.WriteLine();
    AnsiConsole.Write(new Rule().RuleStyle("grey"));
    AnsiConsole.WriteLine();
    // Loop back to the action menu
}

// ============================================================
// Functions
// ============================================================

static string? SelectProject(Settings settings, string settingsPath)
{
    const string addManual = "+ Enter path manually";
    const string scanForSln = "+ Scan for .sln files";
    const string removeProject = "- Remove a saved project";

    if (settings.Projects.Count > 0)
    {
        var choices = settings.Projects.Select(p => $"  {Path.GetFileNameWithoutExtension(p)}  [grey]({p})[/]").ToList();
        choices.Add(addManual);
        choices.Add(scanForSln);
        choices.Add(removeProject);

        var selection = AnsiConsole.Prompt(
            new SelectionPrompt<string>()
                .Title("Select [green]project[/]:")
                .HighlightStyle(new Style(Color.Cyan1))
                .AddChoices(choices));

        if (selection == removeProject)
        {
            var toRemove = AnsiConsole.Prompt(
                new MultiSelectionPrompt<string>()
                    .Title("Select projects to [red]remove[/]:")
                    .AddChoices(settings.Projects));
            foreach (var r in toRemove)
                settings.Projects.Remove(r);
            settings.Save(settingsPath);
            AnsiConsole.MarkupLine($"[red]Removed {toRemove.Count} project(s).[/]");
            return settings.Projects.Count > 0 ? SelectProject(settings, settingsPath) : null;
        }

        if (selection != addManual && selection != scanForSln)
        {
            // Map display string back to path
            var idx = choices.IndexOf(selection);
            return settings.Projects[idx];
        }

        if (selection == scanForSln)
            return ScanAndSelectProject(settings, settingsPath);
    }
    else
    {
        AnsiConsole.MarkupLine("[yellow]No saved projects.[/]");
        var action = AnsiConsole.Prompt(
            new SelectionPrompt<string>()
                .Title("How would you like to add a project?")
                .AddChoices(addManual, scanForSln));

        if (action == scanForSln)
            return ScanAndSelectProject(settings, settingsPath);
    }

    return AddProjectManually(settings, settingsPath);
}

static string? AddProjectManually(Settings settings, string settingsPath)
{
    var path = AnsiConsole.Ask<string>("Path to [green].csproj[/] or directory:");
    path = path.Trim().Trim('"', '\'');
    path = path.Replace("~", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
    path = Path.GetFullPath(path);

    if (Directory.Exists(path))
    {
        var csprojs = Directory.GetFiles(path, "*.csproj");
        if (csprojs.Length == 0)
        {
            AnsiConsole.MarkupLine("[red]No .csproj files found in directory.[/]");
            return null;
        }
        path = csprojs.Length == 1
            ? csprojs[0]
            : AnsiConsole.Prompt(
                new SelectionPrompt<string>()
                    .Title("Select [green].csproj[/]:")
                    .AddChoices(csprojs));
    }

    if (!File.Exists(path) || !path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
    {
        AnsiConsole.MarkupLine($"[red]Not a valid .csproj: {Markup.Escape(path)}[/]");
        return null;
    }

    SaveProject(settings, settingsPath, path);
    return path;
}

static string? ScanAndSelectProject(Settings settings, string settingsPath)
{
    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    var searchRoots = new[] { home };

    // Common dirs to skip for performance
    var skipDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", "bin", "obj", ".nuget", ".dotnet",
        "Library", ".Trash", "Pictures", "Music", "Movies",
        ".cache", ".local", ".npm", ".yarn", ".cargo", ".rustup"
    };

    var solutions = new List<string>();

    AnsiConsole.Status()
        .Spinner(Spinner.Known.Dots)
        .Start("Scanning for .sln / .slnx files (this may take a moment)...", _ =>
        {
            foreach (var root in searchRoots)
            {
                ScanDirectory(root, solutions, skipDirs, maxDepth: 5, currentDepth: 0);
            }
        });

    // Filter out already-added solutions
    var existingDirs = settings.Projects.Select(p => Path.GetDirectoryName(p)!).ToHashSet();
    var newSolutions = solutions
        .Where(s => !existingDirs.Contains(Path.GetDirectoryName(s)!))
        .OrderBy(s => s)
        .ToList();

    if (newSolutions.Count == 0)
    {
        AnsiConsole.MarkupLine("[yellow]No new .sln files found.[/]");
        return AddProjectManually(settings, settingsPath);
    }

    AnsiConsole.MarkupLine($"[green]Found {newSolutions.Count} solution(s)[/]");

    var selected = AnsiConsole.Prompt(
        new SelectionPrompt<string>()
            .Title("Select a [green]solution[/]:")
            .PageSize(15)
            .AddChoices(newSolutions.Select(s =>
            {
                var rel = Path.GetRelativePath(home, s);
                return rel.StartsWith("..") ? s : $"~/{rel}";
            }).Prepend("← Cancel")));

    if (selected == "← Cancel") return null;

    // Resolve back to full path
    var slnPath = selected.StartsWith("~/")
        ? Path.Combine(home, selected[2..])
        : selected;
    slnPath = Path.GetFullPath(slnPath);

    // Find MAUI csproj files in the solution's directory tree
    var slnDir = Path.GetDirectoryName(slnPath)!;
    var csprojs = Directory.GetFiles(slnDir, "*.csproj", SearchOption.AllDirectories)
        .Where(f => IsMauiProject(f))
        .ToList();

    if (csprojs.Count == 0)
    {
        AnsiConsole.MarkupLine("[red]No MAUI .csproj files found in that solution.[/]");
        return null;
    }

    var csproj = csprojs.Count == 1
        ? csprojs[0]
        : AnsiConsole.Prompt(
            new SelectionPrompt<string>()
                .Title("Select [green]MAUI project[/]:")
                .AddChoices(csprojs));

    SaveProject(settings, settingsPath, csproj);
    return csproj;
}

static void ScanDirectory(string dir, List<string> results, HashSet<string> skipDirs, int maxDepth, int currentDepth)
{
    if (currentDepth > maxDepth) return;

    try
    {
        foreach (var file in Directory.EnumerateFiles(dir, "*.sln"))
            results.Add(file);
        foreach (var file in Directory.EnumerateFiles(dir, "*.slnx"))
            results.Add(file);

        foreach (var subDir in Directory.EnumerateDirectories(dir))
        {
            var name = Path.GetFileName(subDir);
            if (name.StartsWith('.') && name != ".dotnet" || skipDirs.Contains(name))
                continue;
            ScanDirectory(subDir, results, skipDirs, maxDepth, currentDepth + 1);
        }
    }
    catch (UnauthorizedAccessException) { }
    catch (DirectoryNotFoundException) { }
}

static bool IsMauiProject(string csprojPath)
{
    try
    {
        var content = File.ReadAllText(csprojPath);
        return content.Contains("UseMaui", StringComparison.OrdinalIgnoreCase)
            || (content.Contains("net", StringComparison.OrdinalIgnoreCase)
                && (content.Contains("-ios", StringComparison.OrdinalIgnoreCase)
                    || content.Contains("-android", StringComparison.OrdinalIgnoreCase)));
    }
    catch { return false; }
}

static void SaveProject(Settings settings, string settingsPath, string path)
{
    if (!settings.Projects.Contains(path))
    {
        settings.Projects.Add(path);
        settings.Save(settingsPath);
        AnsiConsole.MarkupLine($"  [green]Saved:[/] {path}");
    }
}

static List<Platform> DetectPlatforms(string csprojPath)
{
    var content = File.ReadAllText(csprojPath);
    var platforms = new List<Platform>();

    var tfmMatch = Regex.Match(content, @"<TargetFrameworks?>(.*?)</TargetFrameworks?>", RegexOptions.Singleline);
    if (!tfmMatch.Success) return platforms;

    var tfms = tfmMatch.Groups[1].Value;

    var iosMatch = Regex.Match(tfms, @"(net[\d.]+-ios[\d.]*)");
    if (iosMatch.Success)
        platforms.Add(new Platform("iOS", iosMatch.Groups[1].Value));

    var androidMatch = Regex.Match(tfms, @"(net[\d.]+-android[\d.]*)");
    if (androidMatch.Success)
        platforms.Add(new Platform("Android", androidMatch.Groups[1].Value));

    return platforms;
}

static async Task<List<Device>> DetectDevices(Platform platform)
{
    return platform.Name == "iOS"
        ? await DetectIosSimulators()
        : await DetectAndroidDevices();
}

static async Task<List<Device>> DetectIosSimulators()
{
    var devices = new List<Device>();
    try
    {
        var json = await RunCaptureAsync("xcrun", "simctl list devices booted --json");
        using var doc = JsonDocument.Parse(json);
        var devicesObj = doc.RootElement.GetProperty("devices");

        foreach (var runtime in devicesObj.EnumerateObject())
        {
            var runtimeLabel = runtime.Name
                .Replace("com.apple.CoreSimulator.SimRuntime.", "")
                .Replace("-", " ");

            foreach (var d in runtime.Value.EnumerateArray())
            {
                if (d.GetProperty("state").GetString() != "Booted") continue;
                var name = d.GetProperty("name").GetString()!;
                var udid = d.GetProperty("udid").GetString()!;
                devices.Add(new Device(name, udid, $"{name} — {runtimeLabel}"));
            }
        }
    }
    catch { /* xcrun not available */ }
    return devices;
}

static async Task<List<Device>> DetectAndroidDevices()
{
    var devices = new List<Device>();
    try
    {
        var output = await RunCaptureAsync("adb", "devices -l");
        foreach (var line in output.Split('\n').Skip(1))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2 || parts[1] != "device") continue;

            var serial = parts[0];
            var modelMatch = Regex.Match(line, @"model:(\S+)");
            var model = modelMatch.Success ? modelMatch.Groups[1].Value.Replace('_', ' ') : serial;
            devices.Add(new Device(model, serial, $"{model} ({serial})"));
        }
    }
    catch { /* adb not available */ }
    return devices;
}

static string BuildArgs(string projectPath, Platform platform, Device device, string config)
{
    var args = $"build \"{projectPath}\" -t:Run -f {platform.Framework} -c {config}";
    args += $" /p:AdbTarget=\"-s {device.Id}\"";
    return args;
}

static string? FindIosAppBundle(string csprojPath, string framework, string config)
{
    var projectDir = Path.GetDirectoryName(csprojPath)!;
    var binDir = Path.Combine(projectDir, "bin", config, framework);

    if (!Directory.Exists(binDir)) return null;

    // Look for .app directories (could be under iossimulator-arm64/ or similar)
    var apps = Directory.GetDirectories(binDir, "*.app", SearchOption.AllDirectories);
    return apps.Length > 0 ? apps[0] : null;
}

static string? GetBundleId(string appPath)
{
    var plistPath = Path.Combine(appPath, "Info.plist");
    if (!File.Exists(plistPath)) return null;

    try
    {
        // Use PlistBuddy to read CFBundleIdentifier
        using var proc = new Process();
        proc.StartInfo = new ProcessStartInfo
        {
            FileName = "/usr/libexec/PlistBuddy",
            Arguments = $"-c \"Print :CFBundleIdentifier\" \"{plistPath}\"",
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        proc.Start();
        var bundleId = proc.StandardOutput.ReadToEnd().Trim();
        proc.WaitForExit();
        return proc.ExitCode == 0 && !string.IsNullOrEmpty(bundleId) ? bundleId : null;
    }
    catch { return null; }
}

static void OpenLogTerminal(Platform platform, Device device, string projectPath)
{
    // Get path to our own executable
    var selfPath = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
    if (selfPath is null)
    {
        AnsiConsole.MarkupLine("[red]Could not determine executable path for log viewer.[/]");
        return;
    }

    var appName = Path.GetFileNameWithoutExtension(projectPath);
    var logArgs = $"--log {platform.Name} {device.Id} {appName}";
    var windowTitle = $"MauiDeploy Logs - {appName}";

    string cmd;
    if (selfPath.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
        cmd = $"dotnet \\\"{selfPath}\\\" {logArgs}";
    else
        cmd = $"\\\"{selfPath}\\\" {logArgs}";

    // AppleScript via stdin: close existing log window, open new one, set title
    var appleScript = string.Join("\n",
        "tell application \"Terminal\"",
        "  activate",
        $"  set windowList to every window whose custom title is \"{windowTitle}\"",
        "  repeat with w in windowList",
        "    close w",
        "  end repeat",
        $"  do script \"{cmd}\"",
        $"  set custom title of front window to \"{windowTitle}\"",
        "end tell");

    using var proc = new Process();
    proc.StartInfo = new ProcessStartInfo
    {
        FileName = "osascript",
        RedirectStandardInput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
        CreateNoWindow = true
    };
    proc.Start();
    proc.StandardInput.Write(appleScript);
    proc.StandardInput.Close();
    var stderr = proc.StandardError.ReadToEnd();
    proc.WaitForExit();

    if (proc.ExitCode != 0)
        AnsiConsole.MarkupLine($"[red]Log viewer failed: {Markup.Escape(stderr.Trim())}[/]");
    else
        AnsiConsole.MarkupLine($"[green]Log viewer opened for {device.Name}[/]");
}

static async Task<string> RunCaptureAsync(string fileName, string arguments)
{
    using var proc = new Process();
    proc.StartInfo = new ProcessStartInfo
    {
        FileName = fileName,
        Arguments = arguments,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
        CreateNoWindow = true
    };
    proc.Start();
    var output = await proc.StandardOutput.ReadToEndAsync();
    await proc.WaitForExitAsync();
    return output;
}

static async Task<int> RunInteractiveAsync(string fileName, string arguments, CancellationToken ct = default)
{
    using var proc = new Process();
    proc.StartInfo = new ProcessStartInfo
    {
        FileName = fileName,
        Arguments = arguments,
        UseShellExecute = false
    };
    proc.Start();
    try
    {
        await proc.WaitForExitAsync(ct);
        return proc.ExitCode;
    }
    catch (OperationCanceledException)
    {
        try { proc.Kill(entireProcessTree: true); } catch { }
        return -1;
    }
}

// ============================================================
// Log Viewer
// ============================================================

static async Task RunLogViewer(string platform, string deviceId, string appName)
{
    AnsiConsole.Write(new Rule($"[purple bold]MAUI Deploy — Logs[/]").RuleStyle("grey"));
    AnsiConsole.MarkupLine($"  App: [cyan]{appName}[/]  Device: [cyan]{deviceId}[/]");
    AnsiConsole.MarkupLine("[grey]Press Ctrl+C to stop[/]");
    AnsiConsole.Write(new Rule().RuleStyle("grey"));
    AnsiConsole.WriteLine();

    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

    ProcessStartInfo psi;
    Func<string, bool> filter;
    Func<string, (string level, string message)?> parser;

    if (platform == "iOS")
    {
        psi = new ProcessStartInfo
        {
            FileName = "xcrun",
            Arguments = $"simctl spawn {deviceId} log stream --level debug --style compact --predicate 'processImagePath contains \"{appName}\" AND NOT subsystem BEGINSWITH \"com.apple.\"'",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        filter = _ => true; // predicate already filters
        parser = ParseIosLog;
    }
    else
    {
        psi = new ProcessStartInfo
        {
            FileName = "adb",
            Arguments = $"-s {deviceId} logcat",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        filter = line => line.Contains("dotnet", StringComparison.OrdinalIgnoreCase)
                      || line.Contains("mono", StringComparison.OrdinalIgnoreCase)
                      || line.Contains(appName, StringComparison.OrdinalIgnoreCase);
        parser = ParseAndroidLog;
    }

    using var proc = new Process { StartInfo = psi };
    proc.Start();

    try
    {
        var reader = proc.StandardOutput;
        while (!cts.Token.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cts.Token);
            if (line is null) break;
            if (!filter(line)) continue;

            var parsed = parser(line);
            if (parsed is null)
            {
                AnsiConsole.MarkupLine($"[grey]{Markup.Escape(line)}[/]");
                continue;
            }

            var (level, message) = parsed.Value;
            var (levelColor, levelLabel) = level.ToUpperInvariant() switch
            {
                "E" or "ERROR" or "FAULT" => ("red bold", "ERR"),
                "W" or "WARN" or "WARNING" or "DEFAULT" => ("yellow", "WRN"),
                "I" or "INFO" or "NOTICE" => ("green", "INF"),
                "D" or "DEBUG" => ("blue", "DBG"),
                "V" or "VERBOSE" => ("grey", "VRB"),
                _ => ("white", level.Length > 3 ? level[..3].ToUpperInvariant() : level.ToUpperInvariant())
            };

            AnsiConsole.MarkupLine($"[{levelColor}]{levelLabel}[/] {Markup.Escape(message)}");
        }
    }
    catch (OperationCanceledException) { }
    finally
    {
        try { proc.Kill(entireProcessTree: true); } catch { }
    }

    AnsiConsole.WriteLine();
    AnsiConsole.MarkupLine("[grey]Log viewer stopped.[/]");
}

static (string level, string message)? ParseIosLog(string line)
{
    var match = Regex.Match(line, @"^\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+(.*)");
    if (!match.Success) return null;
    return (match.Groups[1].Value, match.Groups[2].Value);
}

static (string level, string message)? ParseAndroidLog(string line)
{
    var match = Regex.Match(line, @"^\S+\s+\S+\s+\d+\s+\d+\s+([VDIWEF])\s+(.*)");
    if (!match.Success) return null;
    return (match.Groups[1].Value, match.Groups[2].Value);
}

// ============================================================
// Types
// ============================================================

record Platform(string Name, string Framework)
{
    public string Display => $"{Name} ({Framework})";
}

record Device(string Name, string Id, string Display);

class Settings
{
    public List<string> Projects { get; set; } = [];

    public static Settings Load(string path)
    {
        if (!File.Exists(path)) return new Settings();
        try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(path)) ?? new Settings(); }
        catch { return new Settings(); }
    }

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}
