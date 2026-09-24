import * as vscode from 'vscode';
import type { ToolboxPick, ToolboxPickItem } from './toolboxModel';

interface ToolPickItem extends vscode.QuickPickItem {
    device?: ToolboxPickItem['device'];
}

export type ToolQuickPick<Item extends ToolPickItem> = Pick<vscode.QuickPick<Item>,
    'title' | 'placeholder' | 'value' | 'items' | 'selectedItems' | 'activeItems' | 'busy' | 'enabled'
    | 'canSelectMany' | 'matchOnDescription' | 'matchOnDetail' | 'ignoreFocusOut'
    | 'onDidAccept' | 'onDidHide' | 'onDidChangeValue' | 'show' | 'hide' | 'dispose'>;

interface PickerPresenter {
    reveal(): Thenable<unknown>;
    update(): void;
}

let presenter: PickerPresenter | undefined;
let nextPickerId = 0;
const openPickers = new Set<SidebarPicker<ToolPickItem>>();

export function registerToolPickers(next: PickerPresenter): vscode.Disposable {
    presenter = next;
    return { dispose: () => {
        if (presenter !== next) return;
        presenter = undefined;
        cancelToolPickers();
    } };
}

export function cancelToolPickers(): void {
    for (const picker of [...openPickers]) picker.hide();
}

export function getToolPicker(): ToolboxPick | undefined {
    return openPickers.values().next().value?.snapshot();
}

export function handleToolPickerMessage(message: Record<string, unknown>): void {
    const picker = openPickers.values().next().value;
    if (!picker || message.id !== picker.id) return;
    if (message.type === 'toolboxPickCancel') picker.hide();
    if (!picker.enabled) return;
    if (message.type === 'toolboxPickInput' && typeof message.value === 'string' && message.value.length <= 8192) {
        picker.value = message.value;
    }
    if (message.type === 'toolboxPickFocus' && typeof message.itemId === 'string') picker.focusItem(message.itemId);
    if ((message.type === 'toolboxPickSelection' || message.type === 'toolboxPickAccept') && Array.isArray(message.itemIds)
        && message.itemIds.every(id => typeof id === 'string')) {
        picker.select(message.itemIds, message.type === 'toolboxPickAccept');
    }
}

export function createToolQuickPick<Item extends ToolPickItem>(): ToolQuickPick<Item> {
    if (!presenter) return vscode.window.createQuickPick<Item>();
    return new SidebarPicker<Item>();
}

export function showToolQuickPick<Item extends ToolPickItem>(items: readonly Item[], options: vscode.QuickPickOptions & { canPickMany: true }, token?: vscode.CancellationToken): Promise<Item[] | undefined>;
export function showToolQuickPick<Item extends ToolPickItem>(items: readonly Item[], options?: vscode.QuickPickOptions, token?: vscode.CancellationToken): Promise<Item | undefined>;
export async function showToolQuickPick<Item extends ToolPickItem>(items: readonly Item[], options: vscode.QuickPickOptions = {}, token?: vscode.CancellationToken): Promise<Item | Item[] | undefined> {
    if (!presenter) return vscode.window.showQuickPick(items, options, token);
    const picker = createToolQuickPick<Item>();
    picker.title = options.title;
    picker.placeholder = options.placeHolder;
    picker.canSelectMany = options.canPickMany ?? false;
    picker.matchOnDescription = options.matchOnDescription ?? false;
    picker.matchOnDetail = options.matchOnDetail ?? false;
    picker.items = items;
    picker.selectedItems = items.filter(item => item.picked);
    return new Promise(resolve => {
        let finished = false;
        const subscriptions: vscode.Disposable[] = [];
        const finish = (selected?: readonly Item[]) => {
            if (finished) return;
            finished = true;
            for (const subscription of subscriptions) subscription.dispose();
            picker.dispose();
            if (options.canPickMany) resolve(selected ? [...selected] : undefined);
            else resolve(selected?.[0]);
        };
        subscriptions.push(picker.onDidHide(() => finish()), picker.onDidAccept(() => finish(picker.selectedItems)));
        if (token) subscriptions.push(token.onCancellationRequested(() => finish()));
        if (token?.isCancellationRequested) { finish(); return; }
        picker.show();
    });
}

class SidebarPicker<Item extends ToolPickItem> implements ToolQuickPick<Item> {
    readonly id = `picker-${++nextPickerId}`;
    private readonly accepted = new vscode.EventEmitter<void>();
    private readonly hidden = new vscode.EventEmitter<void>();
    private readonly changed = new vscode.EventEmitter<string>();
    readonly onDidAccept = this.accepted.event;
    readonly onDidHide = this.hidden.event;
    readonly onDidChangeValue = this.changed.event;
    private readonly ids = new WeakMap<Item, string>();
    private nextItemId = 0;
    private closed = false;
    private options = { title: undefined as string | undefined, placeholder: undefined as string | undefined,
        value: '', busy: false, enabled: true, canSelectMany: false, matchOnDescription: false, matchOnDetail: false };
    private choices: readonly Item[] = [];
    private selection: readonly Item[] = [];
    private active: readonly Item[] = [];
    ignoreFocusOut = true;

    get title() { return this.options.title; }
    set title(value: string | undefined) { this.options.title = value; this.update(); }
    get placeholder() { return this.options.placeholder; }
    set placeholder(value: string | undefined) { this.options.placeholder = value; this.update(); }
    get busy() { return this.options.busy; }
    set busy(value: boolean) { this.options.busy = value; this.update(); }
    get enabled() { return this.options.enabled; }
    set enabled(value: boolean) { this.options.enabled = value; this.update(); }
    get canSelectMany() { return this.options.canSelectMany; }
    set canSelectMany(value: boolean) { this.options.canSelectMany = value; this.update(); }
    get matchOnDescription() { return this.options.matchOnDescription; }
    set matchOnDescription(value: boolean) { this.options.matchOnDescription = value; this.update(); }
    get matchOnDetail() { return this.options.matchOnDetail; }
    set matchOnDetail(value: boolean) { this.options.matchOnDetail = value; this.update(); }
    get value() { return this.options.value; }
    set value(value: string) {
        if (this.closed || value === this.options.value) return;
        this.options.value = value;
        this.changed.fire(value);
        this.update();
    }
    get items() { return this.choices; }
    set items(items: readonly Item[]) {
        this.choices = items;
        this.selection = this.selection.filter(item => items.includes(item));
        this.active = this.active.filter(item => items.includes(item));
        this.update();
    }
    get selectedItems() { return this.selection; }
    set selectedItems(items: readonly Item[]) { this.selection = items.filter(item => this.choices.includes(item)); this.update(); }
    get activeItems() { return this.active; }
    set activeItems(items: readonly Item[]) { this.active = items.filter(item => this.choices.includes(item)); this.update(); }

    private itemId(item: Item): string {
        let id = this.ids.get(item);
        if (!id) { id = `${this.id}-${++this.nextItemId}`; this.ids.set(item, id); }
        return id;
    }

    private update(): void {
        if (!this.closed && openPickers.has(this)) presenter?.update();
    }

    snapshot(): ToolboxPick {
        const text = (value: string | undefined) => value?.replace(/\$\([^)]+\)\s*/g, '').trim();
        return {
            id: this.id, title: this.title ?? 'Select', placeholder: this.placeholder, value: this.value,
            busy: this.busy, enabled: this.enabled, multiple: this.canSelectMany,
            matchDescription: this.matchOnDescription, matchDetail: this.matchOnDetail,
            items: this.items.map(item => ({ id: this.itemId(item), label: text(item.label) ?? '',
                description: text(item.description), detail: text(item.detail),
                device: item.device && { platform: item.device.platform, type: item.device.type, transport: item.device.transport },
                separator: item.kind === vscode.QuickPickItemKind.Separator, alwaysShow: item.alwaysShow })),
            selectedIds: this.selectedItems.map(item => this.itemId(item)),
            activeId: this.activeItems[0] ? this.itemId(this.activeItems[0]) : undefined,
        };
    }

    focusItem(id: string): void {
        const item = this.items.find(item => this.itemId(item) === id && item.kind !== vscode.QuickPickItemKind.Separator);
        if (item) this.activeItems = [item];
    }

    select(ids: string[], accept: boolean): void {
        const choices = new Map(this.items.filter(item => item.kind !== vscode.QuickPickItemKind.Separator).map(item => [this.itemId(item), item]));
        if (new Set(ids).size !== ids.length || ids.some(id => !choices.has(id))) return;
        if (!this.canSelectMany && ids.length !== 1) return;
        this.selectedItems = ids.map(id => choices.get(id)!);
        if (accept) this.accepted.fire();
    }

    show(): void {
        if (this.closed) return;
        openPickers.add(this);
        this.update();
        Promise.resolve(presenter?.reveal()).catch(() => this.hide());
    }

    hide(): void { this.dispose(); }

    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        openPickers.delete(this);
        this.hidden.fire();
        this.accepted.dispose();
        this.hidden.dispose();
        this.changed.dispose();
        presenter?.update();
    }
}