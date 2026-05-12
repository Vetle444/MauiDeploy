using Newtonsoft.Json.Linq;

namespace MauiDeploy.Debugger;

public class LaunchConfig
{
    public string ProjectPath { get; }
    public string Configuration { get; }
    public string Platform { get; }
    public string Framework { get; }
    public string DeviceId { get; }
    public string DeviceName { get; }
    public string DeviceType { get; }
    public string ProgramPath { get; }
    public string AppName { get; }
    public int DebugPort { get; }

    public LaunchConfig(Dictionary<string, JToken> properties)
    {
        ProjectPath = properties.GetValueOrDefault("projectPath")?.Value<string>() ?? "";
        Configuration = properties.GetValueOrDefault("configuration")?.Value<string>() ?? "Debug";
        Platform = properties.GetValueOrDefault("platform")?.Value<string>() ?? "";
        Framework = properties.GetValueOrDefault("framework")?.Value<string>() ?? "";
        DeviceId = properties.GetValueOrDefault("deviceId")?.Value<string>() ?? "";
        DeviceName = properties.GetValueOrDefault("deviceName")?.Value<string>() ?? "";
        DeviceType = properties.GetValueOrDefault("deviceType")?.Value<string>() ?? "simulator";
        ProgramPath = properties.GetValueOrDefault("programPath")?.Value<string>() ?? "";
        AppName = Path.GetFileNameWithoutExtension(ProjectPath);
        DebugPort = properties.GetValueOrDefault("debugPort")?.Value<int>() ?? GetFreePort();
    }

    private static int GetFreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        int port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }
}
