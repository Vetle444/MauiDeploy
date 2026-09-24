export const sourceNames = ['checks.previous.jsonl', 'checks.jsonl'] as const;
export type SourceName = typeof sourceNames[number] | `checks-${string}.jsonl`;
export type SurvivorKind = 'root' | 'visual' | 'bindingContext';

export interface Survivor {
  kind: SurvivorKind;
  type: string;
}

export interface CheckRecord {
  schemaVersion: 1;
  checkedAtUtc: string;
  rootType: string;
  alive: boolean;
  gcRounds: number;
  survivors: Survivor[];
}

export interface CheckEvent extends CheckRecord {
  id: string;
  sourceId: string;
  sourceName: SourceName;
  line: number;
  timestamp: number;
  timeOrder: string;
}

export interface SourceOrigin {
  id: string;
  label: string;
}

export interface SourceMetadata {
  id: string;
  name: SourceName;
  size: number;
  lastModified: number;
  importedAt: number;
  origin?: SourceOrigin;
}

export interface ImportIssue {
  line: number;
  reason: 'invalid-json' | 'invalid-record' | 'unsupported-version';
  version?: number;
}

export interface ImportedSource extends SourceMetadata {
  events: CheckEvent[];
  issues: ImportIssue[];
  nonEmptyLines: number;
}

export interface EventFilters {
  from?: number;
  to?: number;
  rootType: string;
  alive: 'all' | 'true' | 'false';
  survivorType: string;
  kind: 'all' | SurvivorKind;
}

export interface RootTypeSummary {
  rootType: string;
  total: number;
  survived: number;
}

export const emptyFilters: EventFilters = {
  rootType: '', alive: 'all', survivorType: '', kind: 'all',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTypeName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSurvivor(value: unknown): value is Survivor {
  if (!isObject(value) || !isTypeName(value.type)) return false;
  return value.kind === 'root' || value.kind === 'visual' || value.kind === 'bindingContext';
}

function readUtcTimestamp(value: unknown): { timestamp: number; timeOrder: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(?:Z|\+00:00)$/.exec(value);
  if (!match) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  if (new Date(timestamp).toISOString().slice(0, 19) !== match[1]) return undefined;
  return { timestamp, timeOrder: `${match[1]}.${(match[2] ?? '').padEnd(7, '0')}` };
}

export function isSourceName(name: string): name is SourceName {
  return sourceNames.some(sourceName => sourceName === name) || /^checks-[^/\\\u0000-\u001f]+\.jsonl$/.test(name);
}

export function parseJsonl(content: string, source: SourceMetadata): ImportedSource {
  const events: CheckEvent[] = [];
  const issues: ImportIssue[] = [];
  let nonEmptyLines = 0;
  const lines = content.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);

  for (const [index, lineContent] of lines.entries()) {
    if (lineContent.trim() === '') continue;
    const line = index + 1;
    nonEmptyLines++;
    let value: unknown;
    try {
      value = JSON.parse(lineContent);
    } catch {
      issues.push({ line, reason: 'invalid-json' });
      continue;
    }

    if (!isObject(value) || !Number.isSafeInteger(value.schemaVersion)) {
      issues.push({ line, reason: 'invalid-record' });
      continue;
    }
    if (value.schemaVersion !== 1) {
      issues.push({ line, reason: 'unsupported-version', version: value.schemaVersion as number });
      continue;
    }

    const time = readUtcTimestamp(value.checkedAtUtc);
    if (!time || !isTypeName(value.rootType) || typeof value.alive !== 'boolean'
      || !Number.isSafeInteger(value.gcRounds) || (value.gcRounds as number) < 0
      || !Array.isArray(value.survivors) || !value.survivors.every(isSurvivor)) {
      issues.push({ line, reason: 'invalid-record' });
      continue;
    }

    events.push({
      id: `${source.id}:${line}`,
      sourceId: source.id,
      sourceName: source.name,
      line,
      schemaVersion: 1,
      checkedAtUtc: value.checkedAtUtc as string,
      rootType: value.rootType,
      alive: value.alive,
      gcRounds: value.gcRounds as number,
      survivors: value.survivors.map(survivor => ({ kind: survivor.kind, type: survivor.type })),
      ...time,
    });
  }

  return { ...source, events, issues, nonEmptyLines };
}

export function replaceSources(current: ImportedSource[], incoming: ImportedSource[]): ImportedSource[] {
  const byName = new Map(current.map(source => [source.name, source]));
  for (const source of incoming) byName.set(source.name, source);
  return [...byName.values()].sort((first, second) => compareSourceNames(first.name, second.name));
}

function compareSourceNames(first: SourceName, second: SourceName): number {
  if (first === second) return 0;
  const firstBase = first.replace(/\.previous\.jsonl$/, '.jsonl');
  const secondBase = second.replace(/\.previous\.jsonl$/, '.jsonl');
  const comparison = firstBase.localeCompare(secondBase);
  if (comparison !== 0) return comparison;
  return first.endsWith('.previous.jsonl') ? -1 : 1;
}

export function chronologicalEvents(sources: ImportedSource[]): CheckEvent[] {
  return sources.flatMap(source => source.events).sort((first, second) => {
    const timeComparison = first.timeOrder.localeCompare(second.timeOrder);
    if (timeComparison !== 0) return timeComparison;
    const sourceComparison = compareSourceNames(first.sourceName, second.sourceName);
    if (sourceComparison !== 0) return sourceComparison;
    return first.line - second.line;
  });
}

export function filterEvents(events: CheckEvent[], filters: EventFilters): CheckEvent[] {
  const typeQuery = filters.survivorType.trim().toLocaleLowerCase('en-US');
  return events.filter(event => {
    if (filters.from !== undefined && event.timestamp < filters.from) return false;
    if (filters.to !== undefined && event.timestamp > filters.to) return false;
    if (filters.rootType && event.rootType !== filters.rootType) return false;
    if (filters.alive === 'true' && !event.alive) return false;
    if (filters.alive === 'false' && event.alive) return false;
    if (filters.kind === 'all' && typeQuery === '') return true;
    return event.survivors.some(survivor => {
      if (filters.kind !== 'all' && survivor.kind !== filters.kind) return false;
      return survivor.type.toLocaleLowerCase('en-US').includes(typeQuery);
    });
  });
}

export function summarizeEvents(events: CheckEvent[]) {
  const survived = events.filter(event => event.alive).length;
  return {
    total: events.length,
    survived,
    notSurvived: events.length - survived,
    survivalRate: events.length === 0 ? 0 : survived / events.length,
  };
}

export function summarizeRootTypes(events: CheckEvent[]) {
  const groups = new Map<string, RootTypeSummary>();
  for (const event of events) {
    let group = groups.get(event.rootType);
    if (!group) {
      group = { rootType: event.rootType, total: 0, survived: 0 };
      groups.set(event.rootType, group);
    }
    group.total++;
    if (event.alive) group.survived++;
  }
  return [...groups.values()].sort((first, second) =>
    second.survived - first.survived || second.total - first.total || first.rootType.localeCompare(second.rootType));
}

export function bucketEvents(events: CheckEvent[], bucketCount = 32) {
  if (events.length === 0) return [];
  let start = events[0].timestamp;
  let end = start;
  for (const event of events) {
    start = Math.min(start, event.timestamp);
    end = Math.max(end, event.timestamp);
  }
  const count = Math.max(1, Math.floor(bucketCount));
  const duration = Math.max(end - start, 1);
  const buckets = Array.from({ length: count }, (_, index) => ({
    from: start + duration * index / count,
    to: start + duration * (index + 1) / count,
    total: 0,
    survived: 0,
  }));
  for (const event of events) {
    const index = Math.min(count - 1, Math.floor((event.timestamp - start) / duration * count));
    buckets[index].total++;
    if (event.alive) buckets[index].survived++;
  }
  return buckets;
}