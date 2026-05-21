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

        // Try mlaunch first (supports debug port natively), fall back to simctl
        var mlaunchPath = FindMlaunch();

        if (mlaunchPath != null)
            LaunchIosWithMlaunch(mlaunchPath, onOutput, onError);
        else
            LaunchIosWithSimctl(onOutput, onError);
    }

    private void LaunchIosWithMlaunch(string mlaunchPath, Action<string> onOutput, Action<string> onError)
    {
        onOutput($"Using mlaunch: {mlaunchPath}");

        // Install and launch via mlaunch in one step
        var args = $"--launchsim \"{_config.ProgramPath}\" " +
                   $"--device=:v2:udid={_config.DeviceId} " +
                   $"--argument=-monodevelop-port --argument={_config.DebugPort} " +
                   $"--setenv=__XAMARIN_DEBUG_PORT__={_config.DebugPort} " +
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

        // Launch app via devicectl
        onOutput("Launching app on device...");
        var launchArgs = $"devicectl device process launch --device {_config.DeviceId} -- {bundleId}";
        onOutput($"xcrun {launchArgs}");
        RunAndWait("xcrun", launchArgs, onOutput, onError);
        EnsureIproxyStillRunning(iproxyProcess, "after launching the app");

        // Brief wait for the app's debug listener to start (it listens on port 10000)
        onOutput("Waiting for app debug listener...");
        Thread.Sleep(500);
    }

    private void LaunchIosWithSimctl(Action<string> onOutput, Action<string> onError)
    {
        onOutput("mlaunch not found, using xcrun simctl...");

        // Install
        onOutput("Installing app...");
        RunAndWait("xcrun", $"simctl install {_config.DeviceId} \"{_config.ProgramPath}\"", onOutput, onError);

        // Get bundle ID
        var bundleId = GetBundleId(_config.ProgramPath);
        if (string.IsNullOrEmpty(bundleId))
            throw new InvalidOperationException("Could not determine bundle ID from app bundle");

        onOutput($"Bundle ID: {bundleId}");

        // Terminate existing instance
        RunAndWait("xcrun", $"simctl terminate {_config.DeviceId} {bundleId}", onOutput, _ => { });

        // Launch with debug environment
        // SIMCTL_CHILD_ prefix sets env vars in the launched process
        var env = new Dictionary<string, string>
        {
            ["SIMCTL_CHILD___XAMARIN_DEBUG_PORT__"] = _config.DebugPort.ToString(),
        };

        var launchArgs = $"simctl launch {_config.DeviceId} {bundleId} -monodevelop-port {_config.DebugPort}";
        onOutput($"xcrun {launchArgs}");
        RunAndWait("xcrun", launchArgs, onOutput, onError, env);

        // Give app time to start
        Thread.Sleep(2000);
    }

    // ── Android ────────────────────────────────────────

    private void LaunchAndroid(Action<string> onOutput, Action<string> onError)
    {
        var appName = _config.AppName;

        // Install APK
        onOutput("Installing APK...");
        RunAndWait("adb", $"-s {_config.DeviceId} install -r \"{_config.ProgramPath}\"", onOutput, onError);

        // Set debug connection property
        RunAndWait("adb", $"-s {_config.DeviceId} shell setprop debug.mono.connect port={_config.DebugPort}", onOutput, onError);

        // Forward debug port
        RunAndWait("adb", $"-s {_config.DeviceId} forward tcp:{_config.DebugPort} tcp:{_config.DebugPort}", onOutput, onError);

        // Set debug-app flag (makes app wait for debugger)
        RunAndWait("adb", $"-s {_config.DeviceId} shell am set-debug-app {appName}", onOutput, onError);

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

        // Look for Microsoft.iOS.Sdk.net* packs
        var sdkPaths = Directory.GetDirectories(packsDir, "Microsoft.iOS.Sdk.net*")
            .OrderByDescending(Path.GetFileName)
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

        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

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

        // Clean up Android port forwarding
        if (_config.Platform == "Android")
        {
            try { RunAndWait("adb", $"-s {_config.DeviceId} forward --remove-all", _ => { }, _ => { }); }
            catch { /* best effort */ }
        }
    }
}
