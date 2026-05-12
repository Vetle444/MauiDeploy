using System.Net;
using Mono.Debugging.Soft;
using Mono.Debugging.Client;
using Microsoft.VisualStudio.Shared.VSCodeDebugProtocol;
using Microsoft.VisualStudio.Shared.VSCodeDebugProtocol.Messages;
using MonoStackFrame = Mono.Debugging.Client.StackFrame;
using DebugProtocol = Microsoft.VisualStudio.Shared.VSCodeDebugProtocol.Messages;

namespace MauiDeploy.Debugger;

public class MauiDebugSession : DebugAdapterBase
{
    private readonly SoftDebuggerSession _session = new();
    private readonly Handles<MonoStackFrame> _frameHandles = new();
    private readonly Handles<Func<ObjectValue[]>> _variableHandles = new();
    private LaunchConfig _config = null!;
    private DeviceLauncher? _launcher;
    private static readonly string LogFile = "/tmp/mauideploy-debug.log";

    private static void Log(string msg)
    {
        try { File.AppendAllText(LogFile, $"[{DateTime.Now:HH:mm:ss.fff}] {msg}\n"); }
        catch { /* best effort */ }
    }

    public MauiDebugSession(Stream input, Stream output)
    {
        InitializeProtocolClient(input, output);

        _session.ExceptionHandler = ex =>
        {
            OnError($"[MauiDeploy] Session exception: {ex}");
            return true;
        };
        _session.LogWriter = (isError, msg) =>
        {
            if (isError) OnError(msg.Trim());
            else OnOutput(msg.Trim());
        };
        _session.OutputWriter = (isError, msg) =>
        {
            if (isError) OnError(msg);
            else OnOutput(msg);
        };

        _session.TargetStopped += (_, e) =>
        {
            ResetHandles();
            Protocol.SendEvent(new StoppedEvent(StoppedEvent.ReasonValue.Pause)
            {
                ThreadId = (int)e.Thread.Id,
                AllThreadsStopped = true,
            });
        };
        _session.TargetHitBreakpoint += (_, e) =>
        {
            Log($"TargetHitBreakpoint: thread={e.Thread.Id}");
            ResetHandles();
            Protocol.SendEvent(new StoppedEvent(StoppedEvent.ReasonValue.Breakpoint)
            {
                ThreadId = (int)e.Thread.Id,
                AllThreadsStopped = true,
            });
        };
        _session.TargetExceptionThrown += (_, e) =>
        {
            ResetHandles();
            Protocol.SendEvent(new StoppedEvent(StoppedEvent.ReasonValue.Exception)
            {
                Description = "Paused on exception",
                Text = "Exception",
                ThreadId = (int)e.Thread.Id,
                AllThreadsStopped = true,
            });
        };
        _session.TargetUnhandledException += (_, e) =>
        {
            ResetHandles();
            Protocol.SendEvent(new StoppedEvent(StoppedEvent.ReasonValue.Exception)
            {
                Description = "Unhandled exception",
                Text = "Exception",
                ThreadId = (int)e.Thread.Id,
                AllThreadsStopped = true,
            });
        };
        _session.TargetReady += (_, _) =>
        {
            Log("TargetReady fired");
            OnOutput("[MauiDeploy] Debug session ready — sending initialized event.");
            Protocol.SendEvent(new InitializedEvent());
            Log("InitializedEvent sent");
        };
        _session.TargetExited += (_, e) =>
        {
            Log($"TargetExited fired, code={e.ExitCode}");
            OnOutput($"[MauiDeploy] Target exited (code={e.ExitCode}).");
            Protocol.SendEvent(new TerminatedEvent());
        };
        _session.TargetThreadStarted += (_, e) =>
        {
            Log($"ThreadStarted: {e.Thread.Id}");
            Protocol.SendEvent(new ThreadEvent(ThreadEvent.ReasonValue.Started, (int)e.Thread.Id));
        };
        _session.TargetThreadStopped += (_, e) =>
        {
            Log($"ThreadStopped: {e.Thread.Id}");
            Protocol.SendEvent(new ThreadEvent(ThreadEvent.ReasonValue.Exited, (int)e.Thread.Id));
        };
        _session.Breakpoints.BreakpointStatusChanged += (_, e) =>
            Protocol.SendEvent(new BreakpointEvent(BreakpointEvent.ReasonValue.Changed,
                ToBreakpoint(e.Breakpoint)));
    }

    public void Start()
    {
        Log("Protocol.Run() starting");
        Protocol.DispatcherError += (_, e) =>
            Log($"DispatcherError: {e.Exception}");
        Protocol.Run();
        Log("Protocol reader started, waiting...");
        Protocol.WaitForReader();
        Log("Protocol reader exited");
    }

    // ── Initialize ─────────────────────────────────────

    protected override InitializeResponse HandleInitializeRequest(InitializeArguments arguments)
    {
        return new InitializeResponse
        {
            SupportsTerminateRequest = true,
            SupportsConditionalBreakpoints = true,
            SupportsHitConditionalBreakpoints = true,
            SupportsLogPoints = true,
            SupportsSetVariable = true,
            ExceptionBreakpointFilters = new List<ExceptionBreakpointsFilter>
            {
                new() { Filter = "all", Label = "All Exceptions", Default = false }
            }
        };
    }

    // ── Launch ─────────────────────────────────────────

    protected override LaunchResponse HandleLaunchRequest(LaunchArguments arguments)
    {
        _config = new LaunchConfig(arguments.ConfigurationProperties);
        _launcher = new DeviceLauncher(_config);

        OnOutput($"[MauiDeploy] Launching on {_config.DeviceName} ({_config.Platform})...");

        // Determine SDB connection mode
        SoftDebuggerStartArgs startArgs;
        bool listensFirst; // true = debugger listens, then we launch app
        if (_config.Platform == "iOS" && _config.DeviceType == "physical")
        {
            // Physical iOS USB: uses mlaunch protocol over iproxy tunnel.
            // App listens on device:10000, iproxy forwards localhost:debugPort → device:10000.
            // We connect, send "start debugger: sdb" command, then DWP handshake on same socket.
            startArgs = new IosUsbDebuggerArgs(IPAddress.Loopback, _config.DebugPort,
                msg => OnOutput($"[MauiDeploy] {msg}"));
            listensFirst = false;
        }
        else if (_config.Platform == "iOS")
        {
            // iOS simulator: app listens, we connect after launch
            startArgs = new SoftDebuggerConnectArgs(_config.AppName, IPAddress.Loopback, _config.DebugPort);
            listensFirst = false;
        }
        else
        {
            // Android: debugger listens, app connects to us
            startArgs = new SoftDebuggerListenArgs(_config.AppName, IPAddress.Loopback, _config.DebugPort);
            listensFirst = true;
        }

        var startInfo = new SoftDebuggerStartInfo(startArgs);
        var options = new DebuggerSessionOptions
        {
            EvaluationOptions = EvaluationOptions.DefaultOptions
        };

        // Run on background thread — install + launch + SDB connect takes many
        // seconds and would block the DAP protocol thread, causing VS Code to
        // timeout the launch request and kill the session.
        Task.Run(() =>
        {
            try
            {
                if (listensFirst)
                {
                    OnOutput($"[MauiDeploy] Listening for debugger connection on port {_config.DebugPort}...");
                    _session.Run(startInfo, options);

                    _launcher.Launch(msg => OnOutput($"[MauiDeploy] {msg}"),
                                     msg => OnError($"[MauiDeploy] {msg}"));
                }
                else
                {
                    _launcher.Launch(msg => OnOutput($"[MauiDeploy] {msg}"),
                                     msg => OnError($"[MauiDeploy] {msg}"));

                    OnOutput($"[MauiDeploy] Connecting debugger on port {_config.DebugPort}...");
                    _session.Run(startInfo, options);
                }
            }
            catch (Exception ex)
            {
                OnError($"[MauiDeploy] Launch failed: {ex.Message}");
                Protocol.SendEvent(new TerminatedEvent());
            }
        });

        return new LaunchResponse();
    }

    // ── Configuration Done ─────────────────────────────

    protected override ConfigurationDoneResponse HandleConfigurationDoneRequest(
        ConfigurationDoneArguments arguments)
    {
        Log("ConfigurationDone received");
        return new ConfigurationDoneResponse();
    }

    // ── Terminate / Disconnect ─────────────────────────

    protected override TerminateResponse HandleTerminateRequest(TerminateArguments arguments)
    {
        Log("Terminate request received");
        if (!_session.HasExited)
            _session.Exit();

        _launcher?.Dispose();
        Protocol.SendEvent(new TerminatedEvent());
        return new TerminateResponse();
    }

    protected override DisconnectResponse HandleDisconnectRequest(DisconnectArguments arguments)
    {
        Log("Disconnect request received");
        _session.Dispose();
        _launcher?.Dispose();
        return new DisconnectResponse();
    }

    // ── Execution Control ──────────────────────────────

    protected override ContinueResponse HandleContinueRequest(ContinueArguments arguments)
    {
        if (!_session.IsRunning && !_session.HasExited)
            _session.Continue();
        return new ContinueResponse();
    }

    protected override NextResponse HandleNextRequest(NextArguments arguments)
    {
        if (!_session.IsRunning && !_session.HasExited)
            _session.NextLine();
        return new NextResponse();
    }

    protected override StepInResponse HandleStepInRequest(StepInArguments arguments)
    {
        if (!_session.IsRunning && !_session.HasExited)
            _session.StepLine();
        return new StepInResponse();
    }

    protected override StepOutResponse HandleStepOutRequest(StepOutArguments arguments)
    {
        if (!_session.IsRunning && !_session.HasExited)
            _session.Finish();
        return new StepOutResponse();
    }

    protected override PauseResponse HandlePauseRequest(PauseArguments arguments)
    {
        if (_session.IsRunning)
            _session.Stop();
        return new PauseResponse();
    }

    // ── Breakpoints ────────────────────────────────────

    protected override SetBreakpointsResponse HandleSetBreakpointsRequest(SetBreakpointsArguments arguments)
    {
        Log($"SetBreakpoints: {arguments.Source.Path} ({arguments.Breakpoints?.Count ?? 0} bps)");
        try
        {
            var breakpoints = new List<DebugProtocol.Breakpoint>();
            var sourcePath = arguments.Source.Path;

            if (string.IsNullOrEmpty(sourcePath))
                return new SetBreakpointsResponse(breakpoints);

            // Remove existing breakpoints for this file
            foreach (var existing in _session.Breakpoints.GetBreakpointsAtFile(sourcePath))
                _session.Breakpoints.Remove(existing);

            // Add new breakpoints
            foreach (var bp in arguments.Breakpoints)
            {
                var breakpoint = _session.Breakpoints.Add(sourcePath, bp.Line, bp.Column ?? 1);

                if (!string.IsNullOrEmpty(bp.Condition))
                    breakpoint.ConditionExpression = bp.Condition;

                if (!string.IsNullOrEmpty(bp.HitCondition))
                {
                    breakpoint.HitCountMode = HitCountMode.EqualTo;
                    breakpoint.HitCount = int.TryParse(bp.HitCondition, out int hc) ? hc : 1;
                }

                if (!string.IsNullOrEmpty(bp.LogMessage))
                {
                    breakpoint.HitAction = HitAction.PrintExpression;
                    breakpoint.TraceExpression = bp.LogMessage;
                }

                breakpoints.Add(ToBreakpoint(breakpoint));
            }

            Log($"SetBreakpoints done: {sourcePath}");
            return new SetBreakpointsResponse(breakpoints);
        }
        catch (Exception ex)
        {
            Log($"SetBreakpoints FAILED: {ex}");
            throw;
        }
    }

    protected override SetExceptionBreakpointsResponse HandleSetExceptionBreakpointsRequest(
        SetExceptionBreakpointsArguments arguments)
    {
        Log($"SetExceptionBreakpoints: filters={string.Join(",", arguments.Filters ?? new List<string>())}");
        _session.Breakpoints.ClearCatchpoints();

        if (arguments.Filters?.Contains("all") == true)
            _session.Breakpoints.AddCatchpoint(typeof(Exception).ToString());

        Log("SetExceptionBreakpoints done");
        return new SetExceptionBreakpointsResponse();
    }

    // ── Threads ────────────────────────────────────────

    protected override ThreadsResponse HandleThreadsRequest(ThreadsArguments arguments)
    {
        Log("Threads request");
        var threads = new List<DebugProtocol.Thread>();
        var process = _session.GetProcesses().FirstOrDefault();
        if (process == null) return new ThreadsResponse(threads);

        foreach (var thread in process.GetThreads())
        {
            int tid = (int)thread.Id;
            var name = string.IsNullOrEmpty(thread.Name) ? $"Thread {tid}" : thread.Name;
            threads.Add(new DebugProtocol.Thread(tid, name));
        }
        return new ThreadsResponse(threads);
    }

    // ── Stack Trace ────────────────────────────────────

    protected override StackTraceResponse HandleStackTraceRequest(StackTraceArguments arguments)
    {
        Log($"StackTrace: threadId={arguments.ThreadId}");
        var stackFrames = new List<DebugProtocol.StackFrame>();
        var thread = FindThread(arguments.ThreadId);
        var bt = thread?.Backtrace;

        if (bt == null || bt.FrameCount < 0)
            return new StackTraceResponse(stackFrames);

        int total = bt.FrameCount;
        int start = arguments.StartFrame ?? 0;
        int levels = arguments.Levels ?? total;

        for (int i = start; i < Math.Min(start + levels, total); i++)
        {
            Mono.Debugging.Client.StackFrame? frame;
            try { frame = bt.GetFrame(i); }
            catch { continue; }

            if (frame == null) continue;

            var frameId = _frameHandles.Create(frame);
            DebugProtocol.Source? source = null;

            if (!string.IsNullOrEmpty(frame.SourceLocation.FileName) &&
                File.Exists(frame.SourceLocation.FileName))
            {
                source = new DebugProtocol.Source
                {
                    Name = Path.GetFileName(frame.SourceLocation.FileName),
                    Path = frame.SourceLocation.FileName,
                };
            }

            stackFrames.Add(new DebugProtocol.StackFrame
            {
                Id = frameId,
                Source = source,
                Name = frame.AddressSpace ?? frame.ToString() ?? $"Frame {i}",
                Line = frame.SourceLocation.Line,
                Column = frame.SourceLocation.Column,
                EndLine = frame.SourceLocation.EndLine,
                EndColumn = frame.SourceLocation.EndColumn,
            });
        }

        return new StackTraceResponse(stackFrames);
    }

    // ── Scopes ─────────────────────────────────────────

    protected override ScopesResponse HandleScopesRequest(ScopesArguments arguments)
    {
        Log($"Scopes: frameId={arguments.FrameId}");
        var frame = _frameHandles.Get(arguments.FrameId, null);
        var scopes = new List<DebugProtocol.Scope>();

        if (frame != null)
        {
            scopes.Add(new DebugProtocol.Scope
            {
                Name = "Locals",
                PresentationHint = DebugProtocol.Scope.PresentationHintValue.Locals,
                VariablesReference = _variableHandles.Create(frame.GetAllLocals),
            });
        }

        return new ScopesResponse(scopes);
    }

    // ── Variables ──────────────────────────────────────

    protected override VariablesResponse HandleVariablesRequest(VariablesArguments arguments)
    {
        Log($"Variables: ref={arguments.VariablesReference}");
        var variables = new List<DebugProtocol.Variable>();

        if (_variableHandles.TryGet(arguments.VariablesReference, out var getChildren))
        {
            ObjectValue[]? children = null;
            try { children = getChildren?.Invoke(); }
            catch { return new VariablesResponse(variables); }

            if (children != null)
            {
                foreach (var v in children)
                {
                    try
                    {
                        v.WaitHandle.WaitOne(_session.EvaluationOptions.EvaluationTimeout);
                        int childRef = 0;
                        if (v.HasChildren)
                            childRef = _variableHandles.Create(v.GetAllChildren);

                        variables.Add(new DebugProtocol.Variable
                        {
                            Name = v.Name,
                            Type = v.TypeName,
                            Value = v.DisplayValue ?? "null",
                            VariablesReference = childRef,
                        });
                    }
                    catch { /* skip problematic variables */ }
                }
            }
        }

        return new VariablesResponse(variables);
    }

    // ── Evaluate ───────────────────────────────────────

    protected override EvaluateResponse HandleEvaluateRequest(EvaluateArguments arguments)
    {
        var expression = arguments.Expression;
        if (string.IsNullOrWhiteSpace(expression))
            throw new ProtocolException("Invalid expression");

        var frame = _frameHandles.Get(arguments.FrameId ?? 0, null);
        if (frame == null)
            throw new ProtocolException("No active stack frame");

        var value = frame.GetExpressionValue(expression, _session.EvaluationOptions);
        value.WaitHandle.WaitOne(_session.EvaluationOptions.EvaluationTimeout);

        if (value.IsEvaluating)
            throw new ProtocolException("Evaluation timeout");
        if (value.Flags.HasFlag(ObjectValueFlags.Error))
            throw new ProtocolException(value.DisplayValue);

        int handle = 0;
        if (value.HasChildren)
            handle = _variableHandles.Create(value.GetAllChildren);

        return new EvaluateResponse(value.DisplayValue ?? "null", handle);
    }

    // ── Set Variable ───────────────────────────────────

    protected override SetVariableResponse HandleSetVariableRequest(SetVariableArguments arguments)
    {
        if (!_variableHandles.TryGet(arguments.VariablesReference, out var getVars) || getVars == null)
            throw new ProtocolException("Variables reference not found");

        var variables = getVars.Invoke();
        var variable = variables.FirstOrDefault(v => v.Name == arguments.Name);
        if (variable == null)
            throw new ProtocolException("Variable not found");

        variable.SetValue(arguments.Value, _session.EvaluationOptions);
        variable.Refresh();

        return new SetVariableResponse
        {
            Value = variable.DisplayValue ?? "",
            Type = variable.TypeName,
        };
    }

    // ── Exception Info ─────────────────────────────────

    protected override ExceptionInfoResponse HandleExceptionInfoRequest(ExceptionInfoArguments arguments)
    {
        var thread = FindThread(arguments.ThreadId);
        if (thread == null) throw new ProtocolException("No exception available");

        ExceptionInfo? ex = null;
        try
        {
            var frame = thread.Backtrace?.GetFrame(0);
            ex = frame?.GetException();
        }
        catch { }

        return new ExceptionInfoResponse(ex?.Type ?? "Exception", ExceptionBreakMode.Always)
        {
            Description = ex?.Message ?? "An exception occurred",
        };
    }

    // ── Helpers ────────────────────────────────────────

    private ThreadInfo? FindThread(int threadId)
    {
        var process = _session.GetProcesses().FirstOrDefault();
        return process?.GetThreads().FirstOrDefault(t => t.Id == threadId);
    }

    private void ResetHandles()
    {
        _variableHandles.Reset();
        _frameHandles.Reset();
    }

    private static DebugProtocol.Breakpoint ToBreakpoint(Mono.Debugging.Client.Breakpoint bp)
    {
        return new DebugProtocol.Breakpoint
        {
            Verified = true,
            Line = bp.Line,
            Column = bp.Column,
        };
    }

    private static DebugProtocol.Breakpoint ToBreakpoint(BreakEvent bp)
    {
        if (bp is Mono.Debugging.Client.Breakpoint b)
            return ToBreakpoint(b);

        return new DebugProtocol.Breakpoint { Verified = true };
    }

    private void OnOutput(string message)
    {
        Protocol.SendEvent(new OutputEvent { Output = message + "\n", Category = OutputEvent.CategoryValue.Stdout });
    }

    private void OnError(string message)
    {
        Protocol.SendEvent(new OutputEvent { Output = message + "\n", Category = OutputEvent.CategoryValue.Stderr });
    }
}

// ── Handles<T> — maps integer IDs to objects ───────────

internal class Handles<T>
{
    private readonly Dictionary<int, T> _map = new();
    private int _nextId = 1;

    public int Create(T value)
    {
        int id = _nextId++;
        _map[id] = value;
        return id;
    }

    public T Get(int id, T? defaultValue)
    {
        return _map.TryGetValue(id, out var val) ? val : defaultValue!;
    }

    public bool TryGet(int id, out T? value)
    {
        if (_map.TryGetValue(id, out var val))
        {
            value = val;
            return true;
        }
        value = default;
        return false;
    }

    public void Reset()
    {
        _map.Clear();
        _nextId = 1;
    }
}
