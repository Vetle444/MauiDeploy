import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUpRight, Bug, Camera, ChevronRight, CircuitBoard, Eraser, FlaskConical,
  FolderOpen, GitBranch, GitPullRequest, Layers, LoaderCircle, MonitorSmartphone,
  PackageOpen, ScrollText, Settings2, ShieldCheck, Smartphone, Sparkles, Square,
  Terminal, Video, Wrench, X,
} from 'lucide-react';
import { createToolboxSnapshot } from '../../src/toolboxModel';
import type { ToolboxAction, ToolboxSnapshot, ToolboxToolId } from '../../src/toolboxModel';
import { ToolboxPicker } from './ToolboxPicker';
import type { PickerMessage } from './ToolboxPicker';
import logo from '../../icon.png';
import './styles.css';
import './toolbox.css';

const icons = {
  Bug, Camera, CircuitBoard, Eraser, FlaskConical, FolderOpen, GitBranch,
  GitPullRequest, Layers, MonitorSmartphone, PackageOpen, ScrollText, Settings2,
  Sparkles, Square, Terminal, Video,
};
const groups = [
  { id: 'deploy', title: 'Build & deploy', Icon: PackageOpen },
  { id: 'capture', title: 'Device & capture', Icon: MonitorSmartphone },
  { id: 'inspect', title: 'Inspect', Icon: CircuitBoard },
  { id: 'workspace', title: 'Workspace', Icon: Settings2 },
] as const;

const host = window as Window & {
  acquireVsCodeApi?: () => { postMessage(message:
    | PickerMessage
    | { type: 'toolboxReady' }
    | { type: 'toolboxAction'; id: ToolboxToolId }
    | { type: 'toolboxCancelProgress'; id: string }): void };
};
const bridge = host.acquireVsCodeApi?.();
const initial = createToolboxSnapshot({
  configuration: 'Debug', trusted: false, captureSupported: true, debugging: false,
  screenshotBusy: false, recording: { state: 'idle', elapsed: '00:00' }, preview: { state: 'idle' },
});

export function ToolboxApp() {
  const [state, setState] = useState<ToolboxSnapshot>(initial);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLElement>(null);
  const lastAction = useRef<ToolboxToolId | undefined>(undefined);
  const hadPicker = useRef(false);

  useEffect(() => {
    if (state.picker) { hadPicker.current = true; return; }
    const trigger = root.current?.querySelector<HTMLButtonElement>(`button[data-tool="${lastAction.current ?? 'project'}"]`);
    if (hadPicker.current && trigger && !trigger.disabled) {
      hadPicker.current = false;
      trigger.focus();
    }
  }, [state]);

  useEffect(() => {
    if (!bridge) return;
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'toolboxState' && data.state && Array.isArray(data.state.actions)) {
        setState(data.state);
        setConnected(true);
      }
      if (data?.type === 'toolboxError' && typeof data.message === 'string') setError(data.message);
    };
    window.addEventListener('message', receive);
    bridge.postMessage({ type: 'toolboxReady' });
    return () => window.removeEventListener('message', receive);
  }, []);

  function dispatch(action?: ToolboxAction) {
    if (!connected || !action?.enabled) return;
    lastAction.current = action.id;
    setError('');
    bridge?.postMessage({ type: 'toolboxAction', id: action.id });
  }

  const project = state.actions.find(action => action.id === 'project');
  const device = state.actions.find(action => action.id === 'device');
  const configuration = state.actions.find(action => action.id === 'configuration');
  const stop = state.actions.find(action => action.id === 'stop');
  const progress = state.progress ?? [];
  const operation = state.operation;
  const operationHasProgress = Boolean(operation && progress.some(task => task.operationCommand === operation.command));
  const active = progress.length > 0 || state.actions.some(action => action.active);
  let status = 'Ready';
  if (!connected) status = bridge ? 'Connecting' : 'Browser preview';
  else if (!state.trusted) status = 'Restricted mode';
  else if (active) status = 'In progress';

  return <main ref={root} className="toolbox" aria-label="MAUI Deploy tools">
    <header className="toolbox-header">
      <div className="toolbox-brand"><img src={logo} width="34" height="34" alt="" /><div><h1>MAUI Deploy</h1><span>WORKSPACE TOOLS</span></div></div>
      <span className={`toolbox-status ${active ? 'is-working' : ''}`} role="status"><i />{status}</span>
    </header>

    {state.picker ? <ToolboxPicker key={state.picker.id} picker={state.picker} send={message => bridge?.postMessage(message)} /> : <section className="toolbox-context" aria-label="Deployment context">
      <div className="toolbox-project-field"><span className="toolbox-field-label">PROJECT</span>
        <button className="toolbox-project" data-tool="project" title={state.project?.directory ?? 'Select project'} aria-label="Select project" disabled={!connected || !project?.enabled} onClick={() => dispatch(project)}>
          <FolderOpen size={20} /><span><strong>{state.project?.name ?? 'Select project'}</strong><code>{state.project?.directory ?? 'No project selected'}</code></span><ChevronRight size={16} />
        </button>
      </div>
      <div className="toolbox-config-field"><span className="toolbox-field-label">CONFIGURATION</span>
        <div className="toolbox-config" role="group" aria-label="Build configuration">
          {(['Debug', 'Release'] as const).map(value => <button key={value} aria-pressed={state.configuration === value} disabled={!connected || !configuration?.enabled} onClick={() => {
            if (state.configuration !== value) dispatch(configuration);
          }}>{value}</button>)}
        </div>
      </div>
      <div className="toolbox-target"><span className="toolbox-field-label">TARGET</span><button className="toolbox-project" data-tool="device" title={state.device?.name ?? 'Select device'} aria-label="Select device" disabled={!connected || !device?.enabled} onClick={() => dispatch(device)}><Smartphone size={18} /><span><strong>{state.device?.name ?? 'Select device'}</strong>{state.device && <code>{state.device.platform}</code>}</span><ChevronRight size={16} /></button></div>
    </section>}

    {error && <div className="toolbox-feedback" role="alert"><span>{error}</span><button className="icon-button" title="Dismiss message" aria-label="Dismiss message" onClick={() => setError('')}><X size={16} /></button></div>}
    {operation && !operationHasProgress && <section className="toolbox-operation" aria-label="Current operation">
      <LoaderCircle className="toolbox-spinner" size={18} /><div><strong>{operation.message}</strong>{operation.progress !== undefined && <progress aria-label="Build progress" value={operation.progress} max="100" />}</div>
      {operation.progress !== undefined && <code>{operation.progress}%</code>}
      <button className="toolbox-stop" title="Stop current operation" aria-label="Stop operation" disabled={!stop?.enabled} onClick={() => dispatch(stop)}><Square size={15} /></button>
    </section>}
    {progress.map(task => {
      let percent = task.percent;
      if (operation && task.operationCommand === operation.command) percent ??= operation.progress;
      return <section className="toolbox-operation" aria-label={task.title} key={task.id}>
        <LoaderCircle className="toolbox-spinner" size={18} />
        <div><strong>{task.title}</strong><small className="toolbox-progress-message">{task.cancelling ? 'Cancelling...' : task.message}</small>{percent !== undefined && <progress aria-label={`${task.title} progress`} value={percent} max="100" />}</div>
        {task.cancellable && <button className="toolbox-stop" title={`Cancel ${task.title}`} aria-label={`Cancel ${task.title}`} disabled={!connected || task.cancelling} onClick={() => bridge?.postMessage({ type: 'toolboxCancelProgress', id: task.id })}><Square size={15} /></button>}
      </section>;
    })}

    {!state.picker && <div className="toolbox-groups">
      {groups.map(({ id, title, Icon }) => <section className={`toolbox-group group-${id}`} aria-label={title} key={id}>
        <div className="toolbox-group-heading"><Icon size={15} /><h2>{title}</h2></div>
        <div className="toolbox-actions">
          {state.actions.filter(action => action.group === id).map(action => {
            const ActionIcon = icons[action.icon as keyof typeof icons] ?? Wrench;
            return <button className={`toolbox-action ${action.active ? 'is-active' : ''} ${action.stopping ? 'is-stopping' : ''}`} key={action.id} data-tool={action.id} title={action.note ?? action.label} aria-label={action.label} disabled={!connected || !action.enabled} onClick={() => dispatch(action)}>
              <span className="toolbox-action-icon"><ActionIcon size={20} strokeWidth={1.7} /></span>
              <span className="toolbox-action-copy"><strong>{action.label}</strong>{action.note && <small>{action.note}</small>}</span>
              <span className="toolbox-action-end">{action.active && !action.stopping ? <LoaderCircle size={15} className="toolbox-spinner" /> : <ArrowUpRight size={15} />}</span>
            </button>;
          })}
        </div>
      </section>)}
    </div>}
    <footer className="toolbox-footer"><ShieldCheck size={14} /><span>{state.trusted ? 'Trusted workspace' : 'Restricted workspace'}</span><span className="toolbox-footer-config">{state.configuration}</span></footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ToolboxApp /></StrictMode>);