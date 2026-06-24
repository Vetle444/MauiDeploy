using System.Diagnostics;

namespace MauiDeploy.Debugger;

public class DeviceLauncher : IDisposable
{
    private const int IosUsbDeviceWaitTimeoutMilliseconds = 120000;
    private const int IosUsbDeviceRetryDelayMilliseconds = 1000;

    private readonly LaunchConfig _config;
    private readonly List<Process> _processes = new();

    public DeviceLauncher(LaunchConfig config)
    {
        _config = config;
    }

    public void Launch(Action<string> onOutput, Action<string> onError)
    {
        if (_config.Platform == "iOS")
            LaunchIos(onOutput, onError);
        else if (_config.Platform == "Android")
            LaunchAndroid(onOutput, onError);
        else
            throw new InvalidOperationException($"Unsupported platform: {_config.Platform}");
    }

    // ── iOS Simulator ──────────────────────────────────

    private void LaunchIos(Action<string> onOutput, Action<string> onError)
    {
        if (_config.DeviceType == "physical")
        {
            LaunchIosDevice(onOutput, onError);
            return;
        }

        // Use simctl directly for simulator launches.  mlaunch internally sets
        // __XAMARIN_DEBUG_PORT__ / __XAMARIN_DEBUG_HOSTS__ env vars AND passes
        // -monodevelop-port as an argument, creating a dual-config that makes the
        // .NET 10 runtime open two debug connections — the second kills the first.
        LaunchIosWithSimctl(onOutput, onError);
    }

    private void LaunchIosWithMlaunch(string mlaunchPath, Action<string> onOutput, Action<string> onError)
    {
        onOutput($"Using mlaunch: {mlaunchPath}");

        // Install and launch via mlaunch in one step
        var args = $"--launchsim \"{_config.ProgramPath}\" " +
                   $"--device=:v2:udid={_config.DeviceId} " +
                   $"--argument=-monodevelop-port --argument={_config.DebugPort} " +
                   $"--wait-for-exit";

        onOutput($"mlaunch {args}");

        var process = StartProcess(mlaunchPath, args, onOutput, onError);
        _processes.Add(process);

        // Give app time to start and listen on debug port
        Thread.Sleep(2000);
    }

    private void LaunchIosDevice(Action<string> onOutput, Action<string> onError)
    {
        var bundleId = GetBundleId(_config.ProgramPath);
        if (string.IsNullOrEmpty(bundleId))
            throw new InvalidOperationException("Could not determine bundle ID from app bundle");

        onOutput($"Bundle ID: {bundleId}");

        WaitForIosUsbDevice(onOutput);

        // Start iproxy first — the tunnel must be ready before the app launches.
        // The app only waits ~2 seconds for a debugger connection after start.
        // iproxy uses usbmuxd, so it proves the physical USB debug path is available.
        onOutput($"Setting up USB tunnel: localhost:{_config.DebugPort} -> device:10000");
        var iproxyProcess = StartProcess("iproxy",
            $"{_config.DebugPort}:10000 -u {_config.DeviceId}",
            onOutput, onError);
        _processes.Add(iproxyProcess);
        EnsureIproxyStarted(iproxyProcess);

        // Install via devicectl after the USB-only tunnel has been verified.
        // devicectl may see paired devices over Wi-Fi, but the debugger needs USB.
        onOutput("Installing on physical device...");
        RunAndWait("xcrun", $"devicectl device install app --device {_config.DeviceId} \"{_config.ProgramPath}\"",
            onOutput, onError);
        EnsureIproxyStillRunning(iproxyProcess, "after installing the app");

        // Launch app via devicectl with the console attached.  devicectl stays
        // alive until the app exits, so start it as a child process instead of
        // waiting for it to complete; this lets stdout/stderr flow into VS Code
        // while the Mono debugger attaches through the USB tunnel.
        onOutput("Launching app on device with console attached...");
        var launchArgs = $"devicectl device process launch --console --terminate-existing --device {_config.DeviceId} -- {bundleId}";
        onOutput($"xcrun {launchArgs}");
        var consoleProcess = StartProcess("xcrun", launchArgs, onOutput, onError);
        _processes.Add(consoleProcess);
        EnsureIproxyStillRunning(iproxyProcess, "after launching the app");

        // Brief wait for the app's debug listener to start (it listens on port 10000)
        onOutput("Waiting for app debug listener...");
        Thread.Sleep(500);
    }

    private void LaunchIosWithSimctl(Action<string> onOutput, Action<string> onError)
    {
        // Install
        onOutput("Installing app...");
        RunAndWait("xcrun", $"simctl install {_config.DeviceId} \"{_config.ProgramPath}\"", onOutput, onError);

        // Get bundle ID
        var bundleId = GetBundleId(_config.ProgramPath);
        if (string.IsNullOrEmpty(bundleId))
            throw new InvalidOperationException("Could not determine bundle ID from app bundle");

        onOutput($"Bundle ID: {bundleId}");

        // Terminate existing instance (best-effort — may not be running)
        try { RunAndWait("xcrun", $"simctl terminate {_config.DeviceId} {bundleId}", _ => { }, _ => { }); }
        catch { /* not running — fine */ }

        // Launch with ONLY the -monodevelop-port argument.
        // Do NOT set SIMCTL_CHILD___XAMARIN_DEBUG_PORT__ / __HOSTS__ env vars —
        // combining both env-var and argument mechanisms causes the .NET 10 runtime
        // to open two debug connections, and the second kills the first.
        var launchArgs = $"simctl launch --console --terminate-running-process " +
                         $"{_config.DeviceId} {bundleId} " +
                         $"-monodevelop-port {_config.DebugPort}";
        onOutput($"xcrun {launchArgs}");

        var process = StartProcess("xcrun", launchArgs, onOutput, onError);
        _processes.Add(process);

        // Give app time to start
        Thread.Sleep(2000);
    }

    // ── Android ────────────────────────────────────────

    private void LaunchAndroid(Action<string> onOutput, Action<string> onError)
    {
        var appName = _config.ApplicationId ?? _config.AppName;

        // Install APK — can take 30-60s for large MAUI APKs on physical devices
        var apkSize = new FileInfo(_config.ProgramPath).Length / (1024 * 1024);
        onOutput($"Installing APK ({apkSize} MB)... this may take a minute on physical devices");
        RunAndWait("adb", $"-s {_config.DeviceId} install -r \"{_config.ProgramPath}\"", onOutput, onError);
        onOutput("APK installed.");

        // Force-stop any running instance so the next launch starts fresh.
        try { RunAndWait("adb", $"-s {_config.DeviceId} shell am force-stop {appName}", _ => { }, _ => { }); }
        catch { /* might not be running — fine */ }

        // Reverse-tunnel: device localhost:PORT → host localhost:PORT
        // The SDB agent on the device connects to 127.0.0.1:PORT which
        // adb tunnels back to our listener on the host.
        try { RunAndWait("adb", $"-s {_config.DeviceId} reverse --remove tcp:{_config.DebugPort}", _ => { }, _ => { }); }
        catch { /* no existing reverse — fine */ }
        RunAndWait("adb", $"-s {_config.DeviceId} reverse tcp:{_config.DebugPort} tcp:{_config.DebugPort}", onOutput, onError);

        // Clear any stale debug.mono.connect so the runtime doesn't start
        // its own 2-second IDE-protocol listener (which conflicts with our
        // --debugger-agent approach below).
        try { RunAndWait("adb", $"-s {_config.DeviceId} shell setprop debug.mono.connect \"\"", _ => { }, _ => { }); }
        catch { /* fine */ }
        // Clear stale debug.mono.extra to avoid leftover args.
        try { RunAndWait("adb", $"-s {_config.DeviceId} shell setprop debug.mono.extra \"\"", _ => { }, _ => { }); }
        catch { /* fine */ }

        // Tell the Mono SDB agent to connect TO us.  .NET for Android's
        // debug.mono.extra property does NOT accept raw --debugger-agent args;
        // it expects runtime args parsed by monodroid (debug=host:port,
        // timeout=unixTime,server=n).  Monodroid then builds the debugger-agent
        // option internally.  The agent connects to 127.0.0.1:PORT on the
        // device, which adb reverse tunnels to our host listener.
        var timeout = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 120;
        var agentArgs = $"debug=127.0.0.1:{_config.DebugPort},timeout={timeout},server=n,loglevel=10";
        RunAndWait("adb", $"-s {_config.DeviceId} shell setprop debug.mono.extra \"{agentArgs}\"", onOutput, onError);
        RunAndWait("adb", $"-s {_config.DeviceId} shell setprop debug.mono.debug 1", onOutput, onError);

        // Launch
        onOutput("Launching app...");
        RunAndWait("adb", $"-s {_config.DeviceId} shell monkey -p {appName} 1", onOutput, onError);

        // Start logcat
        var logcat = StartProcess("adb", $"-s {_config.DeviceId} logcat -s dotnet mono-rt Mono", onOutput, onError);
        _processes.Add(logcat);
    }

    // ── Helpers ────────────────────────────────────────

    private static string GetLocalIpAddress()
    {
        // Find the local network IP that a physical device would reach
        using var socket = new System.Net.Sockets.Socket(
            System.Net.Sockets.AddressFamily.InterNetwork,
            System.Net.Sockets.SocketType.Dgram, 0);
        socket.Connect("8.8.8.8", 65530); // doesn't send anything, just resolves route
        var endpoint = (System.Net.IPEndPoint)socket.LocalEndPoint!;
        return endpoint.Address.ToString();
    }

    private static string? FindMlaunch()
    {
        var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT")
                         ?? "/usr/local/share/dotnet";
        var packsDir = Path.Combine(dotnetRoot, "packs");

        if (!Directory.Exists(packsDir)) return null;

        // Look for Microsoft.iOS.Sdk.net* packs — sort by parsed version
        // (alphabetical fails: "net9.0" > "net10.0")
        var sdkPaths = Directory.GetDirectories(packsDir, "Microsoft.iOS.Sdk.net*")
            .OrderByDescending(d => ParseSdkVersion(Path.GetFileName(d)))
            .ToArray();

        if (sdkPaths.Length == 0)
        {
            // Legacy path
            var legacyPath = Path.Combine(packsDir, "Microsoft.iOS.Sdk");
            if (Directory.Exists(legacyPath))
                sdkPaths = new[] { legacyPath };
        }

        foreach (var sdkPath in sdkPaths)
        {
            var versions = Directory.GetDirectories(sdkPath)
                .OrderByDescending(Path.GetFileName);

            foreach (var version in versions)
            {
                var mlaunch = Path.Combine(version, "tools", "bin", "mlaunch");
                if (File.Exists(mlaunch)) return mlaunch;
            }
        }

        return null;
    }

    /// <summary>
    /// Parse "Microsoft.iOS.Sdk.netX.Y_Z.W" into a comparable version.
    /// Returns (major * 1000 + minor) so net10.0 > net9.0.
    /// </summary>
    private static int ParseSdkVersion(string dirName)
    {
        // e.g. "Microsoft.iOS.Sdk.net10.0_26.4" → extract "10.0"
        var match = System.Text.RegularExpressions.Regex.Match(dirName, @"net(\d+)\.(\d+)");
        if (match.Success &&
            int.TryParse(match.Groups[1].Value, out var major) &&
            int.TryParse(match.Groups[2].Value, out var minor))
            return major * 1000 + minor;
        return 0;
    }

    private static string? GetBundleId(string appPath)
    {
        var plistPath = Path.Combine(appPath, "Info.plist");
        if (!File.Exists(plistPath)) return null;

        try
        {
            var psi = new ProcessStartInfo("/usr/libexec/PlistBuddy", $"-c \"Print :CFBundleIdentifier\" \"{plistPath}\"")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
            };
            var p = Process.Start(psi);
            var output = p?.StandardOutput.ReadToEnd().Trim();
            p?.WaitForExit();
            return string.IsNullOrEmpty(output) ? null : output;
        }
        catch { return null; }
    }

    private static void RunAndWait(string tool, string args, Action<string> onOutput, Action<string> onError,
        Dictionary<string, string>? env = null)
    {
        var psi = new ProcessStartInfo(tool, args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        if (env != null)
        {
            foreach (var (key, value) in env)
                psi.EnvironmentVariables[key] = value;
        }

        var process = Process.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start {tool}");

        // Read stderr asynchronously to avoid deadlock when both stdout and stderr
        // buffers fill up (classic .NET Process deadlock).
        var stderrBuilder = new System.Text.StringBuilder();
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) stderrBuilder.AppendLine(e.Data); };
        process.BeginErrorReadLine();

        var stdout = process.StandardOutput.ReadToEnd();
        process.WaitForExit();

        var stderr = stderrBuilder.ToString();
        if (!string.IsNullOrWhiteSpace(stdout)) onOutput(stdout.TrimEnd());
        if (!string.IsNullOrWhiteSpace(stderr)) onError(stderr.TrimEnd());

        if (process.ExitCode != 0)
            throw new InvalidOperationException($"{tool} exited with code {process.ExitCode}: {stderr}");
    }

    private static Process StartProcess(string tool, string args, Action<string> onOutput, Action<string> onError)
    {
        var psi = new ProcessStartInfo(tool, args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        var process = Process.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start {tool}");

        process.OutputDataReceived += (_, e) => { if (e.Data != null) onOutput(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) onError(e.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return process;
    }

    private void WaitForIosUsbDevice(Action<string> onOutput)
    {
        var stopwatch = Stopwatch.StartNew();
        var nextStatus = TimeSpan.Zero;

        while (stopwatch.ElapsedMilliseconds < IosUsbDeviceWaitTimeoutMilliseconds)
        {
            if (IsIosUsbDeviceConnected(_config.DeviceId))
            {
                if (stopwatch.ElapsedMilliseconds >= IosUsbDeviceRetryDelayMilliseconds)
                    onOutput("USB device connected.");
                return;
            }

            if (stopwatch.Elapsed >= nextStatus)
            {
                var remainingSeconds = Math.Max(0,
                    (IosUsbDeviceWaitTimeoutMilliseconds - stopwatch.ElapsedMilliseconds) / 1000);
                onOutput(
                    $"Waiting for USB connection to {_config.DeviceName}. " +
                    $"Connect the cable, unlock the device, and tap Trust if prompted. ({remainingSeconds}s remaining)");
                nextStatus = stopwatch.Elapsed + TimeSpan.FromSeconds(5);
            }

            Thread.Sleep(IosUsbDeviceRetryDelayMilliseconds);
        }

        throw new InvalidOperationException(
            $"Timed out waiting for {_config.DeviceName} to appear over USB. " +
            "Physical iOS debugging requires a USB cable and a trusted device; Wi-Fi pairing is not enough for the Mono debugger tunnel.");
    }

    private static bool IsIosUsbDeviceConnected(string deviceId)
    {
        var psi = new ProcessStartInfo("idevice_id", "-l")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start idevice_id. Install libimobiledevice to debug physical iOS devices over USB.");

        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        if (process.ExitCode != 0)
            throw new InvalidOperationException($"idevice_id exited with code {process.ExitCode}: {stderr}");

        return stdout
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Any(id => string.Equals(id.Trim(), deviceId, StringComparison.OrdinalIgnoreCase));
    }

    private static void EnsureIproxyStarted(Process iproxyProcess)
    {
        if (iproxyProcess.WaitForExit(1500))
            ThrowIproxyUnavailable(iproxyProcess, "exited during startup");
    }

    private static void EnsureIproxyStillRunning(Process iproxyProcess, string phase)
    {
        if (iproxyProcess.HasExited)
            ThrowIproxyUnavailable(iproxyProcess, $"exited {phase}");
    }

    private static void ThrowIproxyUnavailable(Process iproxyProcess, string reason)
    {
        var exitCode = iproxyProcess.HasExited ? iproxyProcess.ExitCode.ToString() : "unknown";
        throw new InvalidOperationException(
            $"Could not start the iOS USB debug tunnel: iproxy {reason} (exit code {exitCode}). " +
            "Physical iOS debugging requires the device to be connected with a USB cable and trusted on this Mac. " +
            "devicectl can sometimes see paired devices over Wi-Fi, but the Mono debugger attaches through USB.");
    }

    public void Dispose()
    {
        foreach (var p in _processes)
        {
            try
            {
                if (!p.HasExited)
                {
                    p.Kill();
                    p.WaitForExit(3000);
                }
                p.Dispose();
            }
            catch { /* best effort cleanup */ }
        }
        _processes.Clear();

        // Clean up Android reverse tunnel
        if (_config.Platform == "Android")
        {
            try { RunAndWait("adb", $"-s {_config.DeviceId} reverse --remove-all", _ => { }, _ => { }); }
            catch { /* best effort */ }
        }
    }
}
