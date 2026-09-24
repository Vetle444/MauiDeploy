import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bucketEvents, chronologicalEvents, emptyFilters, filterEvents, isSourceName,
  parseJsonl, replaceSources, summarizeEvents, summarizeRootTypes,
} from '../src/diagnostics.ts';

const record = (overrides = {}) => ({
  schemaVersion: 1,
  checkedAtUtc: '2026-09-23T12:00:00.1234567+00:00',
  rootType: 'Example.EditorPage',
  alive: true,
  gcRounds: 10,
  survivors: [
    { kind: 'visual', type: 'Example.EditorHandler' },
    { kind: 'bindingContext', type: 'Example.EditorViewModel' },
  ],
  ...overrides,
});

const source = (name = 'checks.jsonl', id = name) => ({
  id, name, size: 512, lastModified: 1, importedAt: 2,
});

const parseRecords = (records, name, id) => parseJsonl(records.map(value => JSON.stringify(value)).join('\n'), source(name, id));

test('accepts named diagnostic files, their rotated copies and legacy filenames without accepting paths or unrelated files', () => {
  for (const name of [
    'checks.jsonl', 'checks.previous.jsonl',
    'checks-2026-09-23.jsonl', 'checks-2026-09-23.previous.jsonl',
    'checks-Synthetic.EditorPage.jsonl', 'checks-Synthetic.EditorPage.previous.jsonl',
  ]) {
    assert.equal(isSourceName(name), true, name);
  }
  for (const name of ['checks-.jsonl', 'checks.json', 'other.jsonl', 'checks-one.jsonl.bak', 'checks-folder/file.jsonl', 'checks-folder\\file.jsonl']) {
    assert.equal(isSourceName(name), false, name);
  }
});

test('accepts schema 1, CRLF, BOM, blank lines and an unterminated complete last line', () => {
  const result = parseJsonl(`\uFEFF${JSON.stringify(record())}\r\n\r\n${JSON.stringify(record({ alive: false, survivors: [] }))}`, source());
  assert.equal(result.events.length, 2);
  assert.equal(result.nonEmptyLines, 2);
  assert.deepEqual(result.events.map(event => event.line), [1, 3]);
  assert.equal(result.issues.length, 0);
  assert.equal(result.events[0].sourceName, 'checks.jsonl');
  assert.equal(result.events[0].checkedAtUtc, '2026-09-23T12:00:00.1234567+00:00');
});

test('isolates malformed JSON and truncated records without retaining their contents', () => {
  const content = [JSON.stringify(record()), '{"private":"synthetic-only",', '{}', 'null', '[]', JSON.stringify(record())].join('\n');
  const result = parseJsonl(content, source());
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.issues, [
    { line: 2, reason: 'invalid-json' },
    { line: 3, reason: 'invalid-record' },
    { line: 4, reason: 'invalid-record' },
    { line: 5, reason: 'invalid-record' },
  ]);
  assert.equal(JSON.stringify(result).includes('synthetic-only'), false);
});

test('reports unknown versions separately and continues with supported records', () => {
  const result = parseRecords([record({ schemaVersion: 2 }), record(), record({ schemaVersion: 19 })]);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.issues, [
    { line: 1, reason: 'unsupported-version', version: 2 },
    { line: 3, reason: 'unsupported-version', version: 19 },
  ]);
});

test('validates required field types, UTC calendar dates and every survivor', () => {
  const invalid = [
    { schemaVersion: '1' }, { checkedAtUtc: 'not a date' },
    { checkedAtUtc: '2026-02-30T12:00:00Z' }, { checkedAtUtc: '2026-09-23T12:00:00' },
    { checkedAtUtc: '2026-09-23T25:00:00Z' }, { rootType: ' ' },
    { alive: 'true' }, { gcRounds: -1 }, { gcRounds: 1.5 }, { gcRounds: null },
    { survivors: null }, { survivors: [{ kind: 'handler', type: 'Example.Handler' }] },
    { survivors: [{ kind: 'root' }] }, { survivors: [null] },
  ];
  const result = parseRecords([...invalid.map(overrides => record(overrides)), record()]);
  assert.equal(result.events.length, 1);
  assert.equal(result.issues.length, invalid.length);
  assert.ok(result.issues.every(issue => issue.reason === 'invalid-record'));
});

test('represents an empty or whitespace-only file without fabricated events or errors', () => {
  for (const content of ['', '\uFEFF', ' \n\r\n\t']) {
    const result = parseJsonl(content, source());
    assert.equal(result.nonEmptyLines, 0);
    assert.equal(result.events.length, 0);
    assert.equal(result.issues.length, 0);
  }
});

test('combines both files chronologically and preserves identical repeated checks', () => {
  const repeated = record();
  const previous = parseRecords([record({ checkedAtUtc: '2026-09-23T11:00:00Z' }), repeated], 'checks.previous.jsonl');
  const active = parseRecords([record({ checkedAtUtc: '2026-09-23T14:00:00Z' }), repeated, repeated]);
  const events = chronologicalEvents([active, previous]);
  assert.deepEqual(events.map(event => [event.sourceName, event.line]), [
    ['checks.previous.jsonl', 1], ['checks.previous.jsonl', 2],
    ['checks.jsonl', 2], ['checks.jsonl', 3], ['checks.jsonl', 1],
  ]);
  assert.equal(new Set(events.map(event => event.id)).size, 5);
  assert.equal(events.filter(event => event.rootType === repeated.rootType).length, 5);
});

test('preserves chronological ordering below millisecond precision', () => {
  const events = chronologicalEvents([parseRecords([
    record({ checkedAtUtc: '2026-09-23T12:00:00.1234568Z' }),
    record({ checkedAtUtc: '2026-09-23T12:00:00.1234567+00:00' }),
  ])]);
  assert.deepEqual(events.map(event => event.line), [2, 1]);
});

test('reimport replaces only the selected filename and keeps its new provenance', () => {
  const previous = parseRecords([record()], 'checks.previous.jsonl', 'previous-first');
  const active = parseRecords([record(), record()], 'checks.jsonl', 'active-first');
  const replacement = parseRecords([record({ alive: false, survivors: [] })], 'checks.jsonl', 'active-reloaded');
  const sources = replaceSources([previous, active], [replacement]);
  assert.equal(sources[0], previous);
  assert.equal(sources[1], replacement);
  assert.equal(chronologicalEvents(sources).length, 2);
  assert.equal(sources[1].events[0].sourceId, 'active-reloaded');
  assert.equal(replaceSources(sources, [previous, replacement]).length, 2);
});

test('imports many named and legacy files in timestamp order, preserves provenance and replaces only the reloaded filename', () => {
  const repeated = record();
  const incoming = [
    parseRecords([record({ checkedAtUtc: '2026-09-23T14:00:00Z' }), repeated], 'checks-Synthetic.EditorPage.jsonl'),
    parseRecords([repeated], 'checks.jsonl'),
    parseRecords([record({ checkedAtUtc: '2026-09-23T10:00:00Z' })], 'checks-Synthetic.Dialog.jsonl'),
    parseRecords([repeated], 'checks-Synthetic.EditorPage.previous.jsonl'),
    parseRecords([record({ checkedAtUtc: '2026-09-23T09:00:00Z' })], 'checks.previous.jsonl'),
  ];
  const sources = replaceSources([], incoming);
  assert.equal(sources.length, 5);
  const events = chronologicalEvents(sources);
  assert.deepEqual(events.map(event => [event.sourceName, event.line]), [
    ['checks.previous.jsonl', 1],
    ['checks-Synthetic.Dialog.jsonl', 1],
    ['checks-Synthetic.EditorPage.previous.jsonl', 1],
    ['checks-Synthetic.EditorPage.jsonl', 2],
    ['checks.jsonl', 1],
    ['checks-Synthetic.EditorPage.jsonl', 1],
  ]);
  assert.equal(new Set(events.map(event => event.id)).size, 6);
  assert.deepEqual(chronologicalEvents([...sources].reverse()).map(event => event.id), events.map(event => event.id));
  const replacement = parseRecords([record({ alive: false, survivors: [] })], 'checks-Synthetic.EditorPage.jsonl', 'reloaded');
  const reloaded = replaceSources(sources, [replacement]);
  assert.equal(reloaded.length, 5);
  for (const original of sources.filter(item => item.name !== replacement.name)) {
    assert.equal(reloaded.find(item => item.name === original.name), original);
  }
  assert.equal(reloaded.find(item => item.name === replacement.name), replacement);
  assert.equal(chronologicalEvents(reloaded).length, 5);
});

test('filters time inclusively, exact root type and recorded alive status', () => {
  const events = chronologicalEvents([parseRecords([
    record({ checkedAtUtc: '2026-09-23T10:00:00Z' }),
    record({ checkedAtUtc: '2026-09-23T11:00:00Z', alive: false, survivors: [] }),
    record({ checkedAtUtc: '2026-09-23T12:00:00Z', rootType: 'Example.Dialog' }),
  ])]);
  assert.equal(filterEvents(events, { ...emptyFilters, from: Date.parse('2026-09-23T11:00:00Z'), to: Date.parse('2026-09-23T12:00:00Z') }).length, 2);
  assert.equal(filterEvents(events, { ...emptyFilters, rootType: 'Example.EditorPage', alive: 'false' }).length, 1);
  assert.equal(filterEvents(events, { ...emptyFilters, rootType: 'EditorPage' }).length, 0);
  assert.equal(filterEvents(events, { ...emptyFilters, alive: 'true' }).length, 2);
});

test('category and type must match the same survivor; visual is not split into inferred categories', () => {
  const events = chronologicalEvents([parseRecords([record()])]);
  assert.equal(filterEvents(events, { ...emptyFilters, kind: 'visual', survivorType: 'handler' }).length, 1);
  assert.equal(filterEvents(events, { ...emptyFilters, kind: 'visual', survivorType: 'ViewModel' }).length, 0);
  assert.equal(filterEvents(events, { ...emptyFilters, kind: 'bindingContext', survivorType: '  EDITORVIEWMODEL ' }).length, 1);
  assert.equal(filterEvents(events, { ...emptyFilters, kind: 'root' }).length, 0);
});

test('alive is authoritative, not a root-survival, leak-proof or object-identity inference', () => {
  const events = chronologicalEvents([parseRecords([
    record(), record({ survivors: [] }), record({ alive: false, survivors: [] }),
  ])]);
  assert.deepEqual(summarizeEvents(events), { total: 3, survived: 2, notSurvived: 1, survivalRate: 2 / 3 });
  assert.equal(filterEvents(events, { ...emptyFilters, alive: 'true' }).length, 2);
  assert.equal(events[0].survivors.some(survivor => survivor.kind === 'root'), false);
});

test('root summary counts repeated checks across both files using alive, not survivor entries or short type names', () => {
  const repeated = record({ survivors: [] });
  const events = chronologicalEvents([
    parseRecords([repeated, repeated], 'checks.previous.jsonl'),
    parseRecords([
      repeated,
      record({ alive: false }),
      record({ rootType: 'Other.EditorPage' }),
      record({ rootType: 'Example.Dialog', alive: false, survivors: [] }),
    ]),
  ]);
  const order = events.map(event => event.id);
  assert.deepEqual(summarizeRootTypes(events), [
    { rootType: 'Example.EditorPage', total: 4, survived: 3 },
    { rootType: 'Other.EditorPage', total: 1, survived: 1 },
    { rootType: 'Example.Dialog', total: 1, survived: 0 },
  ]);
  assert.deepEqual(events.map(event => event.id), order);
  assert.deepEqual(summarizeRootTypes([]), []);
});

test('root summary reflects active filters and ranks equal survivor counts by checks, then full type name', () => {
  const events = parseRecords([
    record({ rootType: 'Example.Second' }),
    record({ rootType: 'Example.First' }),
    record({ rootType: 'Example.Frequent' }),
    record({ rootType: 'Example.Frequent', alive: false, survivors: [] }),
  ]).events;
  assert.deepEqual(summarizeRootTypes(events).map(group => group.rootType), ['Example.Frequent', 'Example.First', 'Example.Second']);
  assert.deepEqual(summarizeRootTypes(filterEvents(events, { ...emptyFilters, alive: 'false' })), [
    { rootType: 'Example.Frequent', total: 1, survived: 0 },
  ]);
});

test('timeline counts every check and uses alive rather than the number of survivors', () => {
  const events = chronologicalEvents([parseRecords([
    record({ survivors: [] }), record({ alive: false, survivors: [] }),
    record({ checkedAtUtc: '2026-09-23T14:00:00Z' }),
  ])]);
  const buckets = bucketEvents(events, 8);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.total, 0), 3);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.survived, 0), 2);
  assert.equal(buckets.at(-1).total, 1);
  assert.deepEqual(bucketEvents([]), []);
  assert.equal(bucketEvents([events[0]], 1)[0].total, 1);
});