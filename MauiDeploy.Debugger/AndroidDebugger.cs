using System.Net;
using System.Net.Sockets;
using Mono.Debugger.Soft;
using Mono.Debugging.Client;
using Mono.Debugging.Soft;

namespace MauiDeploy.Debugger;

/// <summary>
/// Connection provider for Android debugging via adb forward tunnel.
///
/// The .NET for Android runtime reads the debug.mono.connect system property
/// and starts a TCP listener that speaks the Xamarin IDE protocol:
///   1. IDE connects via TCP (through adb forward tunnel)
///   2. IDE sends: byte(len) + "start debugger: sdb"
///   3. Runtime saves the socket fd and initializes Mono SDB agent on it
///   4. DWP handshake happens on the same socket
///
/// The runtime's listener only stays active for ~2 seconds after startup,
/// so we need many fast retries to hit the window.  The TCP-level connect
/// through adb forward fails immediately (ECONNREFUSED → EOF) when the
/// device listener isn't up yet, so retries are cheap.
/// </summary>
public class AndroidConnectionProvider : SoftDebuggerStartArgs, ISoftDebuggerConnectionProvider
{
    private readonly IPEndPoint _endpoint;
    private readonly Action<string>? _log;
    private TcpClient? _client;

    public AndroidConnectionProvider(IPAddress address, int port, Action<string>? log = null)
    {
        _endpoint = new IPEndPoint(address, port);
        _log = log;
        // The app needs time to start (process creation + runtime init).
        // The listener is only active for 2 seconds, so we need frequent
        // retries over a long window to catch it.
        MaxConnectionAttempts = 120;
        TimeBetweenConnectionAttempts = 500;
    }

    public override ISoftDebuggerConnectionProvider ConnectionProvider => this;

    public IAsyncResult BeginConnect(DebuggerStartInfo dsi, AsyncCallback callback)
    {
        _client = new TcpClient();
        _log?.Invoke($"Connecting to {_endpoint}...");
        return _client.BeginConnect(_endpoint.Address, _endpoint.Port, callback, null);
    }

    public void EndConnect(IAsyncResult result, out VirtualMachine vm, out string appName)
    {
        _client!.EndConnect(result);
        var stream = _client.GetStream();

        // Send the Xamarin IDE protocol command to start the SDB agent.
        // The runtime's process_cmd() saves this socket fd and hands it
        // to --debugger-agent=transport=socket-fd.
        _log?.Invoke("Sending 'start debugger: sdb'...");
        WriteSdbCommand(stream, "start debugger: sdb");

        // Also send "start profiler: no" to skip the 2-second profiler
        // timeout on the main thread (profiler_configured gets signaled
        // immediately instead of waiting for the condition variable timeout).
        // Note: the runtime processes commands in a loop on the same socket,
        // but after "start debugger: sdb" returns use_fd=true, it exits
        // process_connection().  So this command must come FIRST.
        // Actually — looking at the runtime code, process_connection() reads
        // commands in a while loop.  "start profiler: no" returns false from
        // process_cmd (use_fd=false), so the loop continues.  Then "start
        // debugger: sdb" returns true, exiting the loop.  So the order
        // is: profiler first, then debugger.  But DotNet.Meteor only sends
        // the debugger command and it works fine — the profiler just times
        // out after 2s on the main thread.  We'll keep it simple.

        _log?.Invoke("Waiting for DWP handshake...");
        var connection = new SocketConnection(
            _client.Client, _log);
        vm = VirtualMachineManager.Connect(connection, null, null);

        _log?.Invoke("SDB connection established.");
        appName = "MAUI App";
    }

    public void CancelConnect(IAsyncResult result)
    {
        _client?.Close();
    }

    public bool ShouldRetryConnection(Exception ex)
    {
        // Always retry — adb forward gives fast failures (EOF / refused)
        // when the device listener isn't ready yet.
        return true;
    }

    private static void WriteSdbCommand(Stream stream, string command)
    {
        var buf = new byte[command.Length + 1];
        buf[0] = (byte)command.Length;
        for (int i = 0; i < command.Length; i++)
            buf[i + 1] = (byte)command[i];
        stream.Write(buf, 0, buf.Length);
    }
}
