import { parseJsonl } from './diagnostics';
import type { CheckRecord, SourceName } from './diagnostics';

export function createSampleSources() {
  const started = Date.parse('2026-09-23T09:12:00Z');
  const types = ['Demo.Catalog.ProductPage', 'Demo.Navigation.SettingsPage', 'Demo.Sheets.FilterSheet', 'Demo.Account.ProfilePage'];
  const records: CheckRecord[] = Array.from({ length: 96 }, (_, index) => {
    const rootType = types[index % types.length];
    const alive = index % 7 < 3;
    const survivors: CheckRecord['survivors'] = [];
    if (alive) {
      if (index % 3 !== 0) survivors.push({ kind: 'root', type: rootType });
      survivors.push({ kind: 'visual', type: 'Demo.Controls.SearchInput' });
      if (index % 2 === 0) survivors.push({ kind: 'visual', type: 'Demo.Platform.SearchInputHandler' });
      survivors.push({ kind: 'bindingContext', type: 'Demo.Catalog.ProductViewModel' });
    }
    return { schemaVersion: 1, checkedAtUtc: new Date(started + index * 42_000).toISOString(), rootType, alive, gcRounds: 10, survivors };
  });
  return (['checks.previous.jsonl', 'checks.jsonl'] as SourceName[]).map((name, index) => {
    const lines = records.slice(index * 48, (index + 1) * 48).map(record => JSON.stringify(record));
    if (index === 0) lines.push('{"schemaVersion":1,');
    const content = lines.join('\n');
    return parseJsonl(content, {
      id: `sample-${index}`, name, size: new TextEncoder().encode(content).length,
      lastModified: started + (index + 1) * 48 * 42_000, importedAt: Date.now(),
    });
  });
}