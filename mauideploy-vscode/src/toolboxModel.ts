export const toolboxTools = [
    { id: 'project', group: 'context', label: 'Select project', icon: 'FolderOpen', command: 'mauideploy.pickProject' },
    { id: 'device', group: 'context', label: 'Select device', icon: 'MonitorSmartphone', command: 'mauideploy.pickDevice' },
    { id: 'configuration', group: 'context', label: 'Switch configuration', icon: 'Settings2', command: 'mauideploy.toggleConfig' },
    { id: 'debug', group: 'deploy', label: 'Debug', icon: 'Bug', command: 'mauideploy.debug' },
    { id: 'branch', group: 'deploy', label: 'Deploy branch or PR', icon: 'GitPullRequest', command: 'mauideploy.deployBranch' },
    { id: 'bin', group: 'deploy', label: 'Deploy from bin', icon: 'PackageOpen', command: 'mauideploy.deployFromBin' },
    { id: 'multiple', group: 'deploy', label: 'Run multiple targets', icon: 'Layers', command: 'mauideploy.runMultiple' },
    { id: 'tests', group: 'deploy', label: 'Run tests', icon: 'FlaskConical', command: 'mauideploy.runTests' },
    { id: 'preview', group: 'capture', label: 'Live device preview', icon: 'MonitorSmartphone', command: 'mauideploy.livePreview' },
    { id: 'screenshot', group: 'capture', label: 'Take screenshot', icon: 'Camera', command: 'mauideploy.screenshot' },
    { id: 'recording', group: 'capture', label: 'Record video', icon: 'Video', command: 'mauideploy.recordVideo' },
    { id: 'memory', group: 'inspect', label: 'DUI memory diagnostics', icon: 'CircuitBoard', command: 'mauideploy.memoryDiagnostics' },
    { id: 'logs', group: 'inspect', label: 'Open output', icon: 'ScrollText', command: 'mauideploy.openLogs' },
    { id: 'terminal', group: 'inspect', label: 'Open terminal', icon: 'Terminal', command: 'mauideploy.openTerminal' },
    { id: 'setup', group: 'workspace', label: 'Branch deployment setup', icon: 'GitBranch', command: 'mauideploy.setupBranchDeploy' },
    { id: 'settings', group: 'workspace', label: 'Settings', icon: 'Settings2', command: 'mauideploy.openSettings' },
    { id: 'clean', group: 'workspace', label: 'Clean bin / obj', icon: 'Eraser', command: 'mauideploy.cleanBinObj' },
    { id: 'copilot', group: 'workspace', label: 'Fix last build error', icon: 'Sparkles', command: 'mauideploy.fixBuildErrorWithCopilot' },
    { id: 'stop', group: 'activity', label: 'Stop operation', icon: 'Square', command: 'mauideploy.stop' },
] as const;

export type ToolboxToolId = typeof toolboxTools[number]['id'];
export type ToolboxGroup = typeof toolboxTools[number]['group'];

export interface ToolboxPickItem {
    id: string;
    label: string;
    description?: string;
    detail?: string;
    device?: { platform: 'iOS' | 'Android'; type: 'physical' | 'simulator'; transport?: 'USB' | 'Wi-Fi' };
    separator: boolean;
    alwaysShow?: boolean;
}

export interface ToolboxPick {
    id: string;
    title: string;
    placeholder?: string;
    value: string;
    busy: boolean;
    enabled: boolean;
    multiple: boolean;
    matchDescription: boolean;
    matchDetail: boolean;
    items: ToolboxPickItem[];
    selectedIds: string[];
    activeId?: string;
}

export interface ToolboxProgress {
    id: string;
    title: string;
    message?: string;
    percent?: number;
    cancellable: boolean;
    cancelling: boolean;
    operationCommand?: string;
}

export interface ToolboxContext {
    project?: { name: string; directory: string };
    configuration: 'Debug' | 'Release';
    device?: { name: string; platform: string };
    trusted: boolean;
    captureSupported: boolean;
    operation?: { command: string; message: string; progress?: number; cancelling: boolean };
    progress?: ToolboxProgress[];
    picker?: ToolboxPick;
    debugging: boolean;
    screenshotBusy: boolean;
    recording: { state: string; message?: string; elapsed: string };
    preview: { state: string; message?: string };
}

export interface ToolboxAction {
    id: ToolboxToolId;
    group: ToolboxGroup;
    label: string;
    icon: string;
    command: string;
    enabled: boolean;
    note?: string;
    stopping?: boolean;
    active?: boolean;
}

export interface ToolboxSnapshot extends ToolboxContext {
    actions: ToolboxAction[];
}

export function createToolboxSnapshot(context: ToolboxContext, pending: ReadonlySet<ToolboxToolId> = new Set()): ToolboxSnapshot {
    const pendingBuild = toolboxTools.some(tool => pending.has(tool.id) && (tool.group === 'deploy' || tool.group === 'context' || tool.id === 'clean'));
    const buildBusy = Boolean(context.operation) || pendingBuild;
    const pendingCapture = toolboxTools.some(tool => pending.has(tool.id) && tool.group === 'capture');
    const captureBusy = context.screenshotBusy || context.recording.state !== 'idle' || pendingCapture;
    const actions = toolboxTools.map(tool => {
        const action: ToolboxAction = { ...tool, enabled: !pending.has(tool.id) };
        if (pending.has(tool.id)) {
            action.note = 'In progress';
            action.active = true;
        }
        if (tool.group === 'deploy' || tool.group === 'context' || ['clean', 'setup'].includes(tool.id)) {
            action.enabled = action.enabled && !buildBusy;
        }
        if (tool.group === 'capture') {
            action.enabled = action.enabled && context.captureSupported && !captureBusy;
            if (!context.captureSupported) action.note = 'Requires macOS';
        }
        if (context.operation?.command === action.command) {
            action.active = true;
            action.note = context.operation.message;
        }
        if (tool.id === 'debug' && context.debugging && !context.operation) {
            action.command = 'mauideploy.stopDebug';
            action.label = 'Stop debugging';
            action.icon = 'Square';
            action.stopping = true;
            action.active = true;
            action.enabled = true;
        }
        if (tool.id === 'recording' && context.recording.state !== 'idle') {
            action.active = true;
            action.stopping = true;
            action.icon = 'Square';
            action.note = context.recording.message ?? context.recording.state;
            if (context.recording.state === 'recording') {
                action.label = 'Stop recording';
                action.command = 'mauideploy.stopRecording';
                action.note = context.recording.elapsed;
                action.enabled = true;
            } else {
                action.label = 'Cancel recording';
                action.command = 'mauideploy.cancelRecording';
                action.enabled = !['saving', 'cancelling'].includes(context.recording.state);
            }
        }
        if (tool.id === 'preview' && context.preview.state !== 'idle') {
            action.label = 'Close live preview';
            action.command = 'mauideploy.stopLivePreview';
            action.icon = 'Square';
            action.stopping = true;
            action.active = true;
            action.note = context.preview.message ?? context.preview.state;
            action.enabled = context.preview.state !== 'stopping';
        }
        if (tool.id === 'screenshot' && context.screenshotBusy) {
            action.active = true;
            action.note = 'Taking screenshot';
        }
        if (tool.id === 'stop') {
            action.stopping = true;
            action.enabled = Boolean(context.operation) && !context.operation?.cancelling;
        }
        if (context.picker && !action.stopping) action.enabled = false;
        const needsTrust = !['project', 'device', 'configuration', 'logs', 'terminal', 'settings'].includes(tool.id);
        if (!context.trusted && needsTrust && !action.stopping) {
            action.enabled = false;
            action.note = 'Workspace trust required';
        }
        return action;
    });
    return { ...context, actions };
}