import * as vscode from 'vscode';
import type { ToolboxProgress } from './toolboxModel';

interface ProgressPresenter {
    isVisible(): boolean;
    update(): void;
}

interface ToolProgressOptions extends vscode.ProgressOptions {
    operationCommand?: string;
}

let presenter: ProgressPresenter | undefined;
let nextId = 0;
const tasks = new Map<string, { state: ToolboxProgress; cancellation: vscode.CancellationTokenSource }>();

export function registerToolProgress(presentation: ProgressPresenter): vscode.Disposable {
    presenter = presentation;
    return { dispose: () => {
        if (presenter !== presentation) return;
        presenter = undefined;
        for (const task of tasks.values()) task.cancellation.cancel();
        tasks.clear();
    } };
}

export function getToolProgress(): ToolboxProgress[] {
    return [...tasks.values()].map(task => ({ ...task.state }));
}

export function cancelToolProgress(id: string): void {
    const task = tasks.get(id);
    if (!task?.state.cancellable || task.state.cancelling) return;
    task.state.cancelling = true;
    task.cancellation.cancel();
    presenter?.update();
}

export async function withToolProgress<Result>(options: ToolProgressOptions,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<Result>,
): Promise<Result> {
    const { operationCommand, ...nativeOptions } = options;
    if (!presenter?.isVisible()) return vscode.window.withProgress(nativeOptions, task);

    const id = `progress-${++nextId}`;
    const cancellation = new vscode.CancellationTokenSource();
    const state: ToolboxProgress = {
        id, title: options.title ?? 'MAUI Deploy', cancellable: options.cancellable === true,
        cancelling: false, operationCommand,
    };
    tasks.set(id, { state, cancellation });
    presenter.update();
    try {
        return await task({ report: value => {
            if (!tasks.has(id) || state.cancelling) return;
            if (value.message !== undefined) state.message = value.message;
            if (value.increment !== undefined && Number.isFinite(value.increment)) {
                state.percent = Math.min(100, Math.max(0, (state.percent ?? 0) + value.increment));
            }
            presenter?.update();
        } }, cancellation.token);
    } finally {
        tasks.delete(id);
        cancellation.dispose();
        presenter?.update();
    }
}