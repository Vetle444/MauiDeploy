using System.Net;
using System.Reflection;
using System.Text.Json;
using Mono.Debugging.Soft;
using Mono.Debugging.Client;
using Microsoft.VisualStudio.Shared.VSCodeDebugProtocol;
using Microsoft.VisualStudio.Shared.VSCodeDebugProtocol.Messages;
using Newtonsoft.Json.Linq;
using AppDomainMirror = Mono.Debugger.Soft.AppDomainMirror;
using AssemblyMirror = Mono.Debugger.Soft.AssemblyMirror;
using InvokeOptions = Mono.Debugger.Soft.InvokeOptions;
using MethodMirror = Mono.Debugger.Soft.MethodMirror;
using MonoStackFrame = Mono.Debugging.Client.StackFrame;
using PrimitiveValue = Mono.Debugger.Soft.PrimitiveValue;
using StringMirror = Mono.Debugger.Soft.StringMirror;
using ThreadMirror = Mono.Debugger.Soft.ThreadMirror;
using TypeMirror = Mono.Debugger.Soft.TypeMirror;
using Value = Mono.Debugger.Soft.Value;
using VirtualMachine = Mono.Debugger.Soft.VirtualMachine;
using VMNotSuspendedException = Mono.Debugger.Soft.VMNotSuspendedException;
using DebugProtocol = Microsoft.VisualStudio.Shared.VSCodeDebugProtocol.Messages;

namespace MauiDeploy.Debugger;

public class MauiDebugSession : DebugAdapterBase
{
    private readonly SoftDebuggerSession _session = new();
    private readonly Handles<MonoStackFrame> _frameHandles = new();
    private readonly Handles<Func<ObjectValue[]>> _variableHandles = new();
    private readonly ManualResetEventSlim _targetStoppedSignal = new(false);
    private readonly object _hotReloadInvokeGate = new();
    private LaunchConfig _config = null!;
    private DeviceLauncher? _launcher;
    private long? _lastStoppedThreadId;
    private static readonly string LogFile = "/tmp/mauideploy-debug.log";
    private const string XamlHotReloadRequest = "mauideploy.xamlHotReload";
    private const string XamlHotReloadStatusRequest = "mauideploy.xamlHotReloadStatus";
    private const string XamlHotReloadAgentTypeName = "MauiDeploy.HotReload.XamlHotReloadAgent";

    private static void Log(string msg)
    {
        try { File.AppendAllText(LogFile, $"[{DateTime.Now:HH:mm:ss.fff}] {msg}\n"); }
        catch { /* best effort */ }
    }

    public MauiDebugSession(Stream input, Stream output)
    {
        InitializeProtocolClient(input, output);
        Protocol.RegisterRequestType<XamlHotReloadProtocolRequest, XamlHotReloadArguments, CustomResponseBody>(HandleXamlHotReloadRequest);
        Protocol.RegisterRequestType<XamlHotReloadStatusProtocolRequest, XamlHotReloadStatusArguments, CustomResponseBody>(HandleXamlHotReloadStatusRequest);

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
            RememberStoppedThread(e.Thread.Id);
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
            RememberStoppedThread(e.Thread.Id);
            ResetHandles();
            Protocol.SendEvent(new StoppedEvent(StoppedEvent.ReasonValue.Breakpoint)
            {
                ThreadId = (int)e.Thread.Id,
                AllThreadsStopped = true,
            });
        };
        _session.TargetExceptionThrown += (_, e) =>
        {
            RememberStoppedThread(e.Thread.Id);
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
            RememberStoppedThread(e.Thread.Id);
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
            startArgs = CreateRetryingConnectArgs(_config.AppName, _config.DebugPort);
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
                _launcher?.Dispose();
                Protocol.SendEvent(new TerminatedEvent());
            }
        });

        return new LaunchResponse();
    }

    private static SoftDebuggerConnectArgs CreateRetryingConnectArgs(string appName, int debugPort)
    {
        return new SoftDebuggerConnectArgs(appName, IPAddress.Loopback, debugPort)
        {
            MaxConnectionAttempts = 20,
            TimeBetweenConnectionAttempts = 500,
        };
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
            ContinueTarget();
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

    // ── Custom Requests ───────────────────────────────

    private void HandleXamlHotReloadRequest(IRequestResponder<XamlHotReloadArguments, CustomResponseBody> responder)
    {
        var resourcePath = responder.Arguments.ResourcePath;
        var base64Xaml = responder.Arguments.Base64Xaml;

        if (string.IsNullOrWhiteSpace(resourcePath) || string.IsNullOrWhiteSpace(base64Xaml))
        {
            responder.SetResponse(new CustomResponseBody("error", "Missing XAML Hot Reload payload."));
            return;
        }

        try
        {
            var result = ApplyXamlHotReload(resourcePath, base64Xaml);
            Log($"XAML Hot Reload applied: {result}");
            OnOutput($"[MauiDeploy] XAML Hot Reload: {result}");
            responder.SetResponse(new CustomResponseBody("ok", result));
        }
        catch (Exception ex)
        {
            Log($"XAML Hot Reload failed: {ex}");
            OnError($"[MauiDeploy] XAML Hot Reload failed: {ex.Message}");
            responder.SetResponse(new CustomResponseBody("error", ex.Message));
        }
    }

    private void HandleXamlHotReloadStatusRequest(IRequestResponder<XamlHotReloadStatusArguments, CustomResponseBody> responder)
    {
        var resourcePath = responder.Arguments.ResourcePath;

        if (string.IsNullOrWhiteSpace(resourcePath))
        {
            responder.SetResponse(new CustomResponseBody("error", "Missing XAML Hot Reload status path."));
            return;
        }

        try
        {
            var result = GetXamlHotReloadStatus(resourcePath);
            Log($"XAML Hot Reload status: {result}");
            OnOutput($"[MauiDeploy] XAML Hot Reload status: {result}");
            responder.SetResponse(new CustomResponseBody("ok", result));
        }
        catch (Exception ex)
        {
            Log($"XAML Hot Reload status failed: {ex}");
            OnError($"[MauiDeploy] XAML Hot Reload status failed: {ex.Message}");
            responder.SetResponse(new CustomResponseBody("error", ex.Message));
        }
    }

    private string ApplyXamlHotReload(string resourcePath, string base64Xaml)
    {
        return InvokeHotReloadAgent("ApplyXaml", resourcePath, base64Xaml);
    }

    private string GetXamlHotReloadStatus(string resourcePath)
    {
        return InvokeHotReloadAgent("GetStatus", resourcePath);
    }

    private string InvokeHotReloadAgent(string methodName, params string[] arguments)
    {
        if (_session.HasExited)
            throw new ProtocolException("The debug target has exited.");

        var virtualMachine = _session.VirtualMachine
            ?? throw new ProtocolException("The debug target is not connected.");

        lock (_hotReloadInvokeGate)
        {
            Log($"Suspending VM directly for XAML Hot Reload: method={methodName}, sessionRunning={_session.IsRunning}");
            virtualMachine.Suspend();

            try
            {
                return InvokeHotReloadAgentOnStoppedTarget(virtualMachine, methodName, arguments);
            }
            finally
            {
                if (!_session.HasExited)
                    ResumeVirtualMachineForHotReload(virtualMachine);
            }
        }
    }

    private string InvokeHotReloadAgentOnStoppedTarget(VirtualMachine virtualMachine, string methodName, string[] arguments)
    {
        var agentType = FindHotReloadAgentType(virtualMachine)
            ?? throw new ProtocolException("The XAML Hot Reload agent is not loaded in the debug target. Rebuild the app with Debug first.");
        var method = agentType.GetMethodsByNameFlags(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static, false)
            .FirstOrDefault(candidate => candidate.GetParameters().Length == arguments.Length)
            ?? throw new ProtocolException($"The XAML Hot Reload agent method '{methodName}' was not found.");
        var thread = GetInvocationThread();
        var domain = GetAgentDomain(agentType, virtualMachine);
        var values = arguments.Select(argument => (Value)domain.CreateString(argument)).ToArray();

        Log($"Invoking XAML Hot Reload agent: method={methodName}, thread={SafeThreadName(thread)}, args={arguments.Length}");
        var result = InvokeAgentMethod(virtualMachine, agentType, thread, method, values);

        return result switch
        {
            StringMirror stringMirror => stringMirror.Value,
            PrimitiveValue primitiveValue => primitiveValue.Value?.ToString() ?? string.Empty,
            null => string.Empty,
            _ => result.ToString() ?? string.Empty,
        };
    }

    private static Value InvokeAgentMethod(VirtualMachine virtualMachine, TypeMirror agentType, ThreadMirror thread, MethodMirror method, Value[] values)
    {
        var invocation = agentType.BeginInvokeMethod(
            thread,
            method,
            values,
            InvokeOptions.DisableBreakpoints | InvokeOptions.SingleThreaded,
            null,
            null);

        if (!invocation.AsyncWaitHandle.WaitOne(TimeSpan.FromSeconds(5)))
            throw new ProtocolException("Timed out while invoking the XAML Hot Reload agent.");

        return agentType.EndInvokeMethod(invocation);
    }

    private static void ResumeVirtualMachineForHotReload(VirtualMachine virtualMachine)
    {
        try
        {
            virtualMachine.Resume();
        }
        catch (VMNotSuspendedException)
        {
        }
    }

    private TypeMirror? FindHotReloadAgentType(VirtualMachine virtualMachine)
    {
        var sessionType = _session.GetType(XamlHotReloadAgentTypeName)
            ?? _session.GetAllTypes().FirstOrDefault(type => type.FullName == XamlHotReloadAgentTypeName);
        if (sessionType != null)
        {
            Log($"Found XAML Hot Reload agent from session cache: {sessionType.FullName}");
            return sessionType;
        }

        try
        {
            var vmType = virtualMachine.GetTypes(XamlHotReloadAgentTypeName, false).FirstOrDefault();
            if (vmType != null)
            {
                Log($"Found XAML Hot Reload agent from VM type lookup: {vmType.FullName}");
                return vmType;
            }
        }
        catch (Exception ex)
        {
            Log($"VM type lookup for XAML Hot Reload agent failed: {ex.Message}");
        }

        foreach (var assembly in GetLoadedAssemblies(virtualMachine))
        {
            try
            {
                var assemblyType = assembly.GetType(XamlHotReloadAgentTypeName, false, false);
                if (assemblyType != null)
                {
                    Log($"Found XAML Hot Reload agent in assembly {SafeAssemblyName(assembly)}: {assemblyType.FullName}");
                    return assemblyType;
                }
            }
            catch (Exception ex)
            {
                Log($"Assembly type lookup failed in {SafeAssemblyName(assembly)}: {ex.Message}");
            }
        }

        Log($"XAML Hot Reload agent not found. Loaded assemblies: {string.Join(", ", GetLoadedAssemblies(virtualMachine).Select(SafeAssemblyName).Take(80))}");
        return null;
    }

    private static IEnumerable<AssemblyMirror> GetLoadedAssemblies(VirtualMachine virtualMachine)
    {
        try
        {
            return virtualMachine.RootDomain?.GetAssemblies() ?? Array.Empty<AssemblyMirror>();
        }
        catch
        {
            return Array.Empty<AssemblyMirror>();
        }
    }

    private ThreadMirror GetInvocationThread()
    {
        var threads = _session.VirtualMachine.GetThreads();
        if (threads.Count == 0)
            throw new ProtocolException("No target threads are available for XAML Hot Reload invocation.");

        var preferredThread = GetStoppedThreadMirror(threads);
        if (preferredThread != null && TryGetManagedFrame(preferredThread, out var preferredFrame))
        {
            Log($"Selected stopped XAML Hot Reload invoke thread: {SafeThreadName(preferredThread)} @ {preferredFrame.Method.FullName}");
            return preferredThread;
        }

        foreach (var thread in threads)
        {
            if (TryGetManagedFrame(thread, out var managedFrame))
            {
                Log($"Selected XAML Hot Reload invoke thread: {SafeThreadName(thread)} @ {managedFrame.Method.FullName}");
                return thread;
            }
        }

        Log($"Using fallback XAML Hot Reload invoke thread: {SafeThreadName(threads[0])}");
        return threads[0];
    }

    private ThreadMirror? GetStoppedThreadMirror(IList<ThreadMirror> threads)
    {
        if (!_lastStoppedThreadId.HasValue)
            return null;

        try
        {
            var process = _session.GetProcesses().FirstOrDefault();
            var threadInfos = process?.GetThreads();
            if (threadInfos == null)
                return null;

            var index = Array.FindIndex(threadInfos, thread => thread.Id == _lastStoppedThreadId.Value);
            if (index >= 0 && index < threads.Count)
                return threads[index];
        }
        catch (Exception ex)
        {
            Log($"Could not map stopped thread {_lastStoppedThreadId.Value} to SDB thread mirror: {ex.Message}");
        }

        return null;
    }

    private static bool TryGetManagedFrame(ThreadMirror thread, out Mono.Debugger.Soft.StackFrame managedFrame)
    {
        managedFrame = null!;

        try
        {
            managedFrame = thread.GetFrames().FirstOrDefault(frame => !frame.IsNativeTransition)!;
            return managedFrame != null;
        }
        catch (Exception ex)
        {
            Log($"Skipping XAML Hot Reload invoke thread {SafeThreadName(thread)}: {ex.Message}");
            return false;
        }
    }

    private static AppDomainMirror GetAgentDomain(TypeMirror agentType, VirtualMachine virtualMachine)
    {
        try
        {
            return agentType.Assembly.Domain;
        }
        catch
        {
            return virtualMachine.RootDomain;
        }
    }

    private static string SafeThreadName(ThreadMirror thread)
    {
        try { return thread.Name; }
        catch { return "unknown"; }
    }

    private static string SafeAssemblyName(AssemblyMirror assembly)
    {
        try { return assembly.GetName().Name ?? assembly.Location; }
        catch { return "unknown"; }
    }

    private string EvaluateOnCurrentFrame(string expression)
    {
        var frame = GetEvaluationFrame();
        if (frame == null)
            throw new ProtocolException("No stack frame is available for XAML Hot Reload evaluation.");

        var value = frame.GetExpressionValue(expression, _session.EvaluationOptions);
        value.WaitHandle.WaitOne(_session.EvaluationOptions.EvaluationTimeout);

        if (value.IsEvaluating)
            throw new ProtocolException("XAML Hot Reload evaluation timed out.");
        if (value.Flags.HasFlag(ObjectValueFlags.Unknown) ||
            value.Flags.HasFlag(ObjectValueFlags.NotSupported) ||
            value.Flags.HasFlag(ObjectValueFlags.ImplicitNotSupported))
            throw new ProtocolException("XAML Hot Reload evaluation did not run in a managed frame with debug symbols.");
        if (value.Flags.HasFlag(ObjectValueFlags.Error))
            throw new ProtocolException(value.DisplayValue ?? "XAML Hot Reload evaluation failed.");

        return value.DisplayValue ?? value.Value;
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

            if (arguments.Breakpoints == null)
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

    private MonoStackFrame? GetEvaluationFrame()
    {
        var process = _session.GetProcesses().FirstOrDefault();
        if (process == null)
            return null;

        var threads = process.GetThreads();
        var preferredThread = _lastStoppedThreadId.HasValue
            ? threads.FirstOrDefault(thread => thread.Id == _lastStoppedThreadId.Value)
            : null;

        foreach (var thread in preferredThread == null ? threads : new[] { preferredThread }.Concat(threads))
        {
            try
            {
                var backtrace = thread.Backtrace;
                if (backtrace != null && backtrace.FrameCount > 0)
                    return backtrace.GetFrame(0);
            }
            catch { }
        }

        return null;
    }

    private void RememberStoppedThread(long threadId)
    {
        _lastStoppedThreadId = threadId;
        _targetStoppedSignal.Set();
    }

    private void ContinueTarget()
    {
        _session.Continue();
        Protocol.SendEvent(new ContinuedEvent((int)(_lastStoppedThreadId ?? 0))
        {
            AllThreadsContinued = true,
        });
    }

    private sealed class XamlHotReloadProtocolRequest : DebugRequestWithResponse<XamlHotReloadArguments, CustomResponseBody>
    {
        public const string RequestType = XamlHotReloadRequest;

        public XamlHotReloadProtocolRequest()
            : base(RequestType)
        {
        }
    }

    private sealed class XamlHotReloadStatusProtocolRequest : DebugRequestWithResponse<XamlHotReloadStatusArguments, CustomResponseBody>
    {
        public const string RequestType = XamlHotReloadStatusRequest;

        public XamlHotReloadStatusProtocolRequest()
            : base(RequestType)
        {
        }
    }

    private sealed class XamlHotReloadArguments : DebugRequestArguments
    {
        public string? ResourcePath { get; set; }
        public string? Base64Xaml { get; set; }
    }

    private sealed class XamlHotReloadStatusArguments : DebugRequestArguments
    {
        public string? ResourcePath { get; set; }
    }

    private static string ToCSharpString(string value)
    {
        return "\"" + value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal) + "\"";
    }

    private sealed class CustomResponseBody : ResponseBody
    {
        public CustomResponseBody(string status, string? details)
        {
            AdditionalProperties = new Dictionary<string, JToken>
            {
                ["status"] = JToken.FromObject(status),
                ["details"] = JToken.FromObject(details ?? string.Empty),
            };
        }
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
