using System.Net;
using System.Net.Sockets;
using Mono.Debugger.Soft;
using Mono.Debugging.Client;
using Mono.Debugging.Soft;

namespace MauiDeploy.Debugger;

/// <summary>
/// Implements the Xamarin IDE protocol for iOS simulator debugging.
/// The simulator app connects TO the IDE (WiFi mode), so we listen and accept.
///
/// Protocol flow:
/// 1. IDE listens on localhost:debugPort
/// 2. App launches, reads MonoTouchDebugConfiguration.txt, connects to IDE
/// 3. IDE sends: byte(len) + "start profiler: no"
/// 4. IDE sends: byte(len) + "start debugger: sdb"
/// 5. Runtime sets up SDB custom transport on that socket
/// 6. DWP handshake happens on the same socket
/// 7. SDB protocol is active
/// </summary>
public class IosSimulatorConnectionProvider : ISoftDebuggerConnectionProvider
{
    private readonly int _port;
    private readonly Action<string>? _log;
    private Socket? _socket;
    private Socket? _listener;

    /// <summary>
    /// Signaled once the TCP listener is bound and accepting connections.
    /// The caller should wait on this before launching the app.
    /// </summary>
    public ManualResetEventSlim ListenerReady { get; } = new();

    public IosSimulatorConnectionProvider(int port, Action<string>? log = null)
    {
        _port = port;
        _log = log;
    }

    public IAsyncResult BeginConnect(DebuggerStartInfo dsi, AsyncCallback callback)
    {
        var task = Task.Run(() => ListenAndHandshake());
        task.ContinueWith(_ => callback(task));
        return task;
    }

    public void EndConnect(IAsyncResult result, out VirtualMachine vm, out string appName)
    {
        var task = (Task<VirtualMachine>)result;
        vm = task.Result;
        appName = "MAUI App";
    }

    public void CancelConnect(IAsyncResult result)
    {
        _socket?.Close();
        try { _listener?.Close(); } catch { /* may already be closed */ }
        _listener = null;
    }

    public bool ShouldRetryConnection(Exception ex)
    {
        // Don't retry — we control the listener ourselves
        return false;
    }

    private VirtualMachine ListenAndHandshake()
    {
        _listener = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        _listener.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        _listener.Bind(new IPEndPoint(IPAddress.Loopback, _port));
        _listener.Listen(10);
        ListenerReady.Set();
        _log?.Invoke($"Listening on port {_port} for app connection...");

        _socket = _listener.Accept();

        // Keep the listener open — the .NET runtime may make a second connection
        // attempt to the same port (e.g. from env-var-based debug init). If the
        // listener is closed, the second attempt gets "Connection refused" and the
        // runtime terminates the app.  Leaving it open lets that attempt land in
        // the backlog harmlessly; CancelConnect will close the listener later.

        _socket.NoDelay = true;
        _log?.Invoke($"App connected from {_socket.RemoteEndPoint}");

        // Send IDE protocol commands — same format as IosUsbConnectionProvider
        _log?.Invoke("Sending 'start profiler: no'...");
        SendCommand(_socket, "start profiler: no");

        _log?.Invoke("Sending 'start debugger: sdb'...");
        SendCommand(_socket, "start debugger: sdb");

        // Set a receive timeout for the DWP handshake
        _socket.ReceiveTimeout = 30000; // 30 seconds

        _log?.Invoke("Waiting for DWP handshake...");
        var connection = new SocketConnection(_socket, _log);
        var vm = VirtualMachineManager.Connect(connection, null, null);

        // Clear timeout — normal SDB protocol shouldn't timeout
        _socket.ReceiveTimeout = 0;

        _log?.Invoke("SDB connection established.");
        return vm;
    }

    private static void SendCommand(Socket socket, string command)
    {
        var cmdBytes = System.Text.Encoding.ASCII.GetBytes(command);
        var packet = new byte[1 + cmdBytes.Length];
        packet[0] = (byte)cmdBytes.Length;
        Array.Copy(cmdBytes, 0, packet, 1, cmdBytes.Length);
        socket.Send(packet);
    }
}

/// <summary>
/// Start args for iOS simulator debugging via the Xamarin IDE protocol.
/// Uses IosSimulatorConnectionProvider to listen for the app and negotiate
/// the IDE handshake before SDB.
/// </summary>
public class IosSimulatorDebuggerArgs : SoftDebuggerStartArgs
{
    private readonly IosSimulatorConnectionProvider _provider;

    public IosSimulatorDebuggerArgs(IosSimulatorConnectionProvider provider)
    {
        _provider = provider;
    }

    public override ISoftDebuggerConnectionProvider ConnectionProvider => _provider;
}
