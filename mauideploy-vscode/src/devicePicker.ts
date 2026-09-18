import type * as vscode from 'vscode';
import { detectAllDevices, Device, Platform } from './devices';

export interface DevicePickItem extends vscode.QuickPickItem {
    device?: Device;
}

const deviceRefreshIntervalMs = 3000;

export function showDevicePicker(
    picker: vscode.QuickPick<DevicePickItem>,
    platforms: Platform[],
    buildItems: (devices: Device[]) => DevicePickItem[],
    token?: vscode.CancellationToken
): Promise<Device | undefined> {
    const placeholder = picker.placeholder;
    return new Promise<Device | undefined>(resolve => {
        let closed = false;
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        const subscriptions: vscode.Disposable[] = [];
        const finish = (device?: Device) => {
            if (closed) { return; }
            closed = true;
            if (refreshTimer !== undefined) { clearTimeout(refreshTimer); }
            subscriptions.forEach(subscription => subscription.dispose());
            picker.dispose();
            resolve(device);
        };
        const refreshDevices = async () => {
            if (closed) { return; }
            picker.busy = true;
            try {
                const devices = (await detectAllDevices(platforms)).filter(device => device.available !== false);
                if (closed) { return; }
                const activeDevice = picker.activeItems[0]?.device;
                const items = buildItems(devices);
                picker.items = items;
                const activeItem = items.find(item => sameDevice(item.device, activeDevice));
                if (activeItem) { picker.activeItems = [activeItem]; }
                picker.placeholder = devices.length === 0 ? 'Waiting for devices...' : placeholder;
            } catch {
            } finally {
                if (!closed) {
                    picker.busy = false;
                    refreshTimer = setTimeout(refreshDevices, deviceRefreshIntervalMs);
                }
            }
        };
        subscriptions.push(
            picker.onDidHide(() => finish()),
            picker.onDidAccept(() => {
                const selectedDevice = picker.selectedItems[0]?.device;
                const currentItem = picker.items.find(item => sameDevice(item.device, selectedDevice));
                if (currentItem?.device) { finish(currentItem.device); }
            })
        );
        if (token) { subscriptions.push(token.onCancellationRequested(() => finish())); }
        if (token?.isCancellationRequested) { finish(); return; }
        picker.show();
        void refreshDevices();
    });
}

function sameDevice(left?: Device, right?: Device): boolean {
    return left !== undefined && right !== undefined &&
        left.id === right.id && left.platform === right.platform && left.type === right.type;
}