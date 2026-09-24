import { isSourceName } from './diagnostics';
import type { SourceName, SourceOrigin } from './diagnostics';

interface DeviceFile {
  name: SourceName;
  content: string;
  lastModified: number;
}

export type DeviceImportMessage =
  | { type: 'deviceImportLoading'; requestId: number; origin?: SourceOrigin }
  | { type: 'deviceImportLoaded'; requestId: number; origin: SourceOrigin; files: DeviceFile[] }
  | { type: 'deviceImportError'; requestId: number; message: string };

interface DeviceBridge {
  postMessage(message: { type: 'deviceImportReady' | 'deviceImportRefresh' | 'deviceImportCancel' }): void;
}

const host = window as Window & { acquireVsCodeApi?: () => DeviceBridge };
export const deviceBridge = host.acquireVsCodeApi?.();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrigin(value: unknown): value is SourceOrigin {
  return isObject(value) && typeof value.id === 'string' && typeof value.label === 'string';
}

export function isDeviceImportMessage(value: unknown): value is DeviceImportMessage {
  if (!isObject(value) || !Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1) return false;
  if (value.type === 'deviceImportLoading') return value.origin === undefined || isOrigin(value.origin);
  if (value.type === 'deviceImportError') return typeof value.message === 'string';
  if (value.type !== 'deviceImportLoaded' || !isOrigin(value.origin) || !Array.isArray(value.files) || value.files.length === 0) return false;
  const names = new Set<string>();
  return value.files.every(file => {
    if (!isObject(file) || typeof file.name !== 'string' || !isSourceName(file.name)
      || typeof file.content !== 'string' || typeof file.lastModified !== 'number'
      || !Number.isFinite(new Date(file.lastModified).getTime())) return false;
    if (names.has(file.name)) return false;
    names.add(file.name);
    return true;
  });
}