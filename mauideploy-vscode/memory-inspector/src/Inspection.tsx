import { ArrowDown, ArrowRight, ChevronRight, Clock3, FileJson2, ListOrdered, X } from 'lucide-react';
import { bucketEvents, summarizeEvents } from './diagnostics';
import type { CheckEvent, RootTypeSummary, SourceName, SurvivorKind } from './diagnostics';

export function formatTime(timestamp: number) {
  return new Date(timestamp).toISOString().slice(11, 19);
}

export function formatDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function Overview({ events, total, rootTypeCount }: { events: CheckEvent[]; total: number; rootTypeCount: number }) {
  const summary = summarizeEvents(events);
  const buckets = bucketEvents(events);
  const maximum = Math.max(1, ...buckets.map(bucket => bucket.total));
  const barWidth = 560 / Math.max(buckets.length, 1);
  const first = events[0];
  const last = events.at(-1);
  let mascot = '\u{1F9DF}';
  let mood = 'Still hanging around.';
  if (summary.total === 0) {
    mascot = '\u{1F50E}';
    mood = 'No checks in this view.';
  } else if (summary.survived === 0) {
    mascot = '\u{1F9F9}';
    mood = 'No survivors this time.';
  }

  return <section className="overview" aria-label="Overview">
    <div className="summary-totals">
      <span className="summary-mascot" aria-hidden="true">{mascot}</span>
      <div>
        <h2 className="summary-eyebrow">Zombie watch</h2>
        <p className="summary-statement"><strong className="survived-total" data-testid="survived-count">{summary.survived.toLocaleString('en-US')}</strong> of <strong data-testid="check-count">{summary.total.toLocaleString('en-US')}</strong><span>checks had survivors</span></p>
        <p className="summary-mood">{mood}</p>
      </div>
      <p className="summary-context"><span aria-hidden="true">&#x2705;</span> {summary.notSurvived.toLocaleString('en-US')} with none surviving. {rootTypeCount} root {rootTypeCount === 1 ? 'type' : 'types'}.</p>
      {total !== summary.total && <p className="summary-context">{total.toLocaleString('en-US')} checks imported in total</p>}
    </div>
    <div className="timeline">
      <div className="timeline-heading"><h2>Checks over time</h2><div className="legend"><span><i className="legend-dot survived" /><span aria-hidden="true">&#x1F9DF;</span> Survived GC</span><span><i className="legend-dot collected" /><span aria-hidden="true">&#x2705;</span> None survived</span></div></div>
      <svg className="timeline-chart" viewBox="0 0 600 94" preserveAspectRatio="none" role="img" aria-label={`${summary.total} checks over time, ${summary.survived} with alive true. UTC.`}>
        {[0, 1, 2].map(level => <g key={level}><line x1="30" x2="596" y1={82 - level * 36} y2={82 - level * 36} className="chart-grid" /><text x="22" y={85 - level * 36} textAnchor="end">{Math.round(maximum * level / 2)}</text></g>)}
        {buckets.map((bucket, index) => {
          const aliveHeight = bucket.survived / maximum * 72;
          const otherHeight = (bucket.total - bucket.survived) / maximum * 72;
          return <g key={index} className="timeline-bar" style={{ animationDelay: `${index * 12}ms` }}><title>{formatDate(bucket.from)} {formatTime(bucket.from)} - {formatTime(bucket.to)} UTC: {bucket.total} checks, {bucket.survived} survived GC</title>
            <rect x={33 + index * barWidth} y={82 - aliveHeight} width={Math.max(barWidth - 4, 1)} height={aliveHeight} className="chart-survived" />
            <rect x={33 + index * barWidth} y={82 - aliveHeight - otherHeight} width={Math.max(barWidth - 4, 1)} height={otherHeight} className="chart-collected" />
          </g>;
        })}
      </svg>
      <div className="timeline-axis"><span>{first ? `${formatDate(first.timestamp)} ${formatTime(first.timestamp)}` : 'No checks in this view'}</span><span>{last ? `${formatDate(last.timestamp)} ${formatTime(last.timestamp)} UTC` : 'UTC'}</span></div>
    </div>
  </section>;
}

export function CheckSequence({ events, onSelect, onShowAll }: {
  events: CheckEvent[];
  onSelect: (id: string) => void;
  onShowAll: () => void;
}) {
  if (events.length === 0) return null;
  const recent = events.slice(-6).reverse();
  return <section className="check-sequence" aria-label="Check sequence">
    <div className="sequence-heading">
      <h2><ListOrdered size={15} /> Check sequence</h2>
      <div><span className="muted">Latest {recent.length} of {events.length}</span><button className="icon-button" title="Show all checks" aria-label="Show all checks" onClick={onShowAll}><ArrowRight size={16} /></button></div>
    </div>
    <p className="sequence-note">GC check order, not recorded navigation.</p>
    <ol className="sequence-list" start={events.length} reversed aria-label="Checks, newest first">
      {recent.map(event => <li key={event.id}>
        <button className="sequence-step" title={`${event.rootType}\n${event.checkedAtUtc}\n${event.sourceName}:${event.line}`} aria-label={`Inspect ${event.rootType}, ${event.sourceName} line ${event.line}, alive ${event.alive}`} onClick={() => onSelect(event.id)}>
          <span className="sequence-point"><AliveStatus alive={event.alive} /></span>
          <time dateTime={event.checkedAtUtc}>{formatDate(event.timestamp).slice(5)} {formatTime(event.timestamp)} UTC</time>
          <code>{event.rootType.split('.').at(-1)}</code>
          <span className="sequence-source">{event.sourceName}:{event.line}</span>
        </button>
      </li>)}
    </ol>
  </section>;
}

export function RootSummaryList({ groups, onSelect }: { groups: RootTypeSummary[]; onSelect: (rootType: string) => void }) {
  if (groups.length === 0) return null;
  return <table className="root-summary" aria-label="Summary by root type">
    <colgroup><col /><col className="summary-count-column" /><col className="summary-open-column" /></colgroup>
    <thead><tr><th scope="col">Root type</th><th scope="col" aria-sort="descending" title="Checks with alive: true. Something survived GC; this does not prove a leak.">Zombie checks <ArrowDown size={12} /></th><th scope="col" aria-label="Open checks" /></tr></thead>
    <tbody>{groups.map(group => {
      const separator = group.rootType.lastIndexOf('.');
      return <tr key={group.rootType} onClick={() => onSelect(group.rootType)}>
        <td><button className="row-select" title={group.rootType} aria-label={`Show checks for ${group.rootType}`} onClick={event => { event.stopPropagation(); onSelect(group.rootType); }}>
          <code className="summary-type">{group.rootType.slice(separator + 1)}</code>
          {separator >= 0 && <span className="summary-namespace">{group.rootType.slice(0, separator)}</span>}
        </button></td>
        <td className="summary-result">
          <div><span className="status-emoji" aria-hidden="true">{group.survived > 0 ? '\u{1F9DF}' : '\u2705'}</span><strong className={group.survived > 0 ? 'survived-total' : ''}>{group.survived.toLocaleString('en-US')}</strong><span> / {group.total.toLocaleString('en-US')} checks</span></div>
          <meter min={0} max={group.total} value={group.survived} aria-label={`Checks with survivors for ${group.rootType}`} />
        </td>
        <td><ChevronRight size={16} aria-hidden="true" /></td>
      </tr>;
    })}</tbody>
  </table>;
}

export function AliveStatus({ alive }: { alive: boolean }) {
  const description = alive ? 'Zombie check: something survived GC, not proof of a leak.' : 'No monitored targets survived this check.';
  return <span className={`alive-status ${alive ? 'is-alive' : 'not-alive'}`} role="img" aria-label={description} title={description}>
    <span className="status-emoji" aria-hidden="true">{alive ? '\u{1F9DF}' : '\u2705'}</span>
  </span>;
}

function compactSourceName(name: SourceName): string {
  if (name === 'checks.jsonl') return 'current';
  if (name === 'checks.previous.jsonl') return 'previous';
  return name;
}

export function EventList({ events, selectedId, onSelect }: { events: CheckEvent[]; selectedId?: string; onSelect: (id: string) => void }) {
  if (events.length === 0) return null;
  return <table className="event-table">
    <colgroup><col className="time-column" /><col /><col className="alive-column" /><col className="entries-column" /></colgroup>
    <thead><tr><th>Time <span>UTC</span></th><th>Root type / source</th><th>Alive</th><th className="numeric">Entries</th></tr></thead>
    <tbody>{events.map(event => <tr key={event.id} className={selectedId === event.id ? 'selected-row' : ''} onClick={() => onSelect(event.id)}>
      <td><time dateTime={event.checkedAtUtc}>{formatTime(event.timestamp)}</time><span className="row-date">{formatDate(event.timestamp).slice(5)}</span></td>
      <td><button className="row-select" title={event.rootType} aria-label={`Inspect ${event.rootType}, ${event.sourceName} line ${event.line}`} aria-current={selectedId === event.id ? 'true' : undefined} onClick={eventClick => { eventClick.stopPropagation(); onSelect(event.id); }}>
        <code className="row-root">{event.rootType.split('.').at(-1)}</code>
        <span className="row-source" title={`${event.sourceName}:${event.line}`}><i className={`source-dot ${event.sourceName.endsWith('.previous.jsonl') ? 'previous-source' : 'current-source'}`} /><span className="source-long">{event.sourceName}</span><span className="source-short">{compactSourceName(event.sourceName)}</span><span>:{event.line}</span></span>
      </button></td>
      <td><AliveStatus alive={event.alive} /></td><td className="numeric entry-number">{event.survivors.length}</td>
    </tr>)}</tbody>
  </table>;
}

function groupSurvivors(event: CheckEvent) {
  const groups = new Map<string, { kind: SurvivorKind; type: string; count: number }>();
  for (const survivor of event.survivors) {
    const key = `${survivor.kind}:${survivor.type}`;
    const current = groups.get(key);
    if (current) current.count++;
    else groups.set(key, { ...survivor, count: 1 });
  }
  return [...groups.values()];
}

export function CheckDetails({ event, onClose }: { event: CheckEvent; onClose: () => void }) {
  const survivors = groupSurvivors(event);
  const inconsistent = event.alive !== (event.survivors.length > 0);
  return <>
    <div className="section-heading"><h2>Check details</h2><button className="icon-button" title="Close details" aria-label="Close details" onClick={onClose}><X size={16} /></button></div>
    <div key={event.id} className="detail-body">
      <div className="detail-result"><AliveStatus alive={event.alive} /><span>{event.alive ? 'Zombie check: survived GC' : 'None survived GC'}</span></div>
      <h3 className="detail-root"><code className="full-type">{event.rootType}</code></h3>
      <dl className="check-metadata">
        <dt><Clock3 size={13} /> Checked (UTC)</dt><dd><time dateTime={event.checkedAtUtc}>{event.checkedAtUtc}</time></dd>
        <dt><FileJson2 size={13} /> Source</dt><dd><code>{event.sourceName}</code><span>Line {event.line}</span></dd>
        <dt>GC rounds</dt><dd>{event.gcRounds}</dd>
      </dl>
      <div className="survivor-heading"><h3><span aria-hidden="true">&#x1F50E;</span> Survivor entries</h3><span className="count">{event.survivors.length}</span></div>
      {inconsistent && <p className="record-warning">The recorded alive status and survivor list differ. The status above follows the alive field.</p>}
      {survivors.length === 0 ? <p className="no-survivors">No survivor entries recorded.</p> : <ul className="survivor-list">{survivors.map(survivor => <li key={`${survivor.kind}:${survivor.type}`}>
        <div><span className={`kind-label kind-${survivor.kind}`}><i />{survivor.kind}</span><code>{survivor.type}</code></div><span className="survivor-count" title="Entries of this type in this check">{survivor.count}</span>
      </li>)}</ul>}
    </div>
  </>;
}