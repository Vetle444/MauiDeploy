using System.Net;
using System.Net.Sockets;
using Mono.Debugger.Soft;
using Mono.Debugging.Client;
using Mono.Debugging.Soft;

namespace MauiDeploy.Debugger;

/// <summary>
/// Connection subclass that wraps an already-connected Socket for SDB transport.
/// This is needed because TcpConnection in Mono.Debugger.Soft is internal.
/// </summary>
public class SocketConnection : Connection
{
    private readonly Socket _socket;
    private readonly Action<string>? _log;

    public SocketConnection(Socket socket, Action<string>? log = null)
    {
        _socket = socket;
        _log = log;
    }

    protected override int TransportSend(byte[] buf, int buf_offset, int len)
    {
        try
        {
            return _socket.Send(buf, buf_offset, len, SocketFlags.None);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"TransportSend failed: {ex.GetType().Name}: {ex.Message}");
            throw;
        }
    }

    protected override int TransportReceive(byte[] buf, int buf_offset, int len)
    {
        try
        {
            var n = _socket.Receive(buf, buf_offset, len, SocketFlags.None);
            if (n == 0)
                _log?.Invoke("TransportReceive: remote side closed the socket (EOF)");
            return n;
        }
        catch (Exception ex)
        {
            _log?.Invoke($"TransportReceive failed: {ex.GetType().Name}: {ex.Message}");
            throw;
        }
    }

    protected override void TransportSetTimeouts(int send_timeout, int receive_timeout)
    {
        _log?.Invoke($"TransportSetTimeouts: send={send_timeout}, recv={receive_timeout}");
        _socket.SendTimeout = send_timeout;
        _socket.ReceiveTimeout = receive_timeout;
    }

    protected override void TransportClose()
    {
        _log?.Invoke("TransportClose called");
        _socket.Close();
    }

    protected override void TransportShutdown()
    {
        _log?.Invoke("TransportShutdown called");
        _socket.Shutdown(SocketShutdown.Both);
    }
}

/// <summary>
/// Implements the mlaunch command protocol for iOS USB debugging.
/// The iOS runtime listens on a port and expects a specific handshake:
/// 1. IDE connects via TCP (through iproxy USB tunnel)
/// 2. IDE sends: byte(len) + "start profiler: no" (skips 2s profiler wait)
/// 3. IDE sends: byte(len) + "start debugger: sdb" (on same socket)
/// 4. Runtime sets up SDB custom transport on that socket
/// 5. DWP handshake happens on the same socket
/// 6. SDB protocol is active
/// </summary>
public class IosUsbConnectionProvider : ISoftDebuggerConnectionProvider
{
    private readonly IPEndPoint _endpoint;
    private readonly Action<string>? _log;
    private Socket? _socket;

    public IosUsbConnectionProvider(IPAddress address, int port, Action<string>? log = null)
    {
        _endpoint = new IPEndPoint(address, port);
        _log = log;
    }

    public IAsyncResult BeginConnect(DebuggerStartInfo dsi, AsyncCallback callback)
    {
        var task = Task.Run(() => ConnectWithMlaunchProtocol());
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
    }

    public bool ShouldRetryConnection(Exception ex)
    {
        return ex is SocketException or IOException or TimeoutException;
    }

    private static void SendCommand(Socket socket, string command)
    {
        var cmdBytes = System.Text.Encoding.ASCII.GetBytes(command);
        var packet = new byte[1 + cmdBytes.Length];
        packet[0] = (byte)cmdBytes.Length;
        Array.Copy(cmdBytes, 0, packet, 1, cmdBytes.Length);
        socket.Send(packet);
    }

    private VirtualMachine ConnectWithMlaunchProtocol()
    {
        _log?.Invoke($"Connecting to {_endpoint}...");
        _socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        _socket.Connect(_endpoint);
        _socket.NoDelay = true;

        // Send "start profiler: no" first — this sets profiler_configured=true
        // on the runtime side, eliminating a 2-second accept() timeout wait
        // that blocks mono_jit_init (and thus the SDB agent start).
        // The runtime's monotouch_process_connection() loop reads multiple
        // commands from the same socket.
        _log?.Invoke("Sending 'start profiler: no'...");
        SendCommand(_socket, "start profiler: no");

        _log?.Invoke("Sending 'start debugger: sdb'...");
        SendCommand(_socket, "start debugger: sdb");

        // Set a receive timeout for the DWP handshake.
        // Connection.Connect() does a blocking Receive() waiting for the
        // runtime to send "DWP-Handshake". Without a timeout, this blocks
        // forever if the agent hasn't started yet.
        _socket.ReceiveTimeout = 15000; // 15 seconds

        _log?.Invoke("Waiting for DWP handshake...");
        var connection = new SocketConnection(_socket, _log);
        var vm = VirtualMachineManager.Connect(connection, null, null);

        // Clear timeout after handshake — normal SDB protocol shouldn't timeout
        _socket.ReceiveTimeout = 0;

        _log?.Invoke("SDB connection established.");
        return vm;
    }
}

/// <summary>
/// Start args for physical iOS USB debugging via the mlaunch protocol.
/// Uses IosUsbConnectionProvider to negotiate the mlaunch handshake before SDB.
/// </summary>
public class IosUsbDebuggerArgs : SoftDebuggerStartArgs
{
    private readonly IosUsbConnectionProvider _provider;

    public IosUsbDebuggerArgs(IPAddress address, int port, Action<string>? log = null)
    {
        _provider = new IosUsbConnectionProvider(address, port, log);
        MaxConnectionAttempts = 10;
        TimeBetweenConnectionAttempts = 1000;
    }

    public override ISoftDebuggerConnectionProvider ConnectionProvider => _provider;
}
