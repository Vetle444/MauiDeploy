using MauiDeploy.Debugger;

var logFile = "/tmp/mauideploy-debug.log";
File.WriteAllText(logFile, $"[{DateTime.Now:HH:mm:ss.fff}] Debug adapter starting\n");

// DAP uses stdin/stdout for JSON-RPC framing.  Grab the raw streams BEFORE
// redirecting Console, so the protocol sees the real file descriptors.
var dapIn  = Console.OpenStandardInput();
var dapOut = Console.OpenStandardOutput();

// Redirect Console.Out / Console.Error to the log file.
// debugger-libs (Connection.cs, DebuggerLoggingService, etc.) sprinkle
// Console.WriteLine calls that would inject non-DAP text into stdout
// and corrupt the protocol, causing VS Code to kill the adapter.
var logWriter = new StreamWriter(new FileStream(logFile, FileMode.Append, FileAccess.Write, FileShare.Read))
    { AutoFlush = true };
Console.SetOut(logWriter);
Console.SetError(logWriter);

AppDomain.CurrentDomain.UnhandledException += (_, e) =>
{
    var msg = $"[{DateTime.Now:HH:mm:ss.fff}] FATAL: {e.ExceptionObject}\n";
    Console.Error.WriteLine(msg);
};

var session = new MauiDebugSession(dapIn, dapOut);
try
{
    session.Start();
}
catch (Exception ex)
{
    File.AppendAllText(logFile, $"[{DateTime.Now:HH:mm:ss.fff}] Protocol.Start() threw: {ex}\n");
}

File.AppendAllText(logFile, $"[{DateTime.Now:HH:mm:ss.fff}] Debug adapter exiting\n");
