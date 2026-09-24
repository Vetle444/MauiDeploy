import { RotateCcw, X } from 'lucide-react';
import type { ImportedSource, ImportIssue, SourceName } from './diagnostics';
import { formatDate, formatTime } from './Inspection';

function issueLabel(issue: ImportIssue) {
  if (issue.reason === 'unsupported-version') return `Unsupported schema ${issue.version}`;
  if (issue.reason === 'invalid-json') return 'Invalid or incomplete JSON';
  return 'Invalid or missing fields';
}

export function SourcePanel({ sources, disabled, onChoose, onRemove }: {
  sources: ImportedSource[];
  disabled: boolean;
  onChoose: (name?: SourceName) => void;
  onRemove: (name: SourceName) => void;
}) {
  if (sources.length === 0) return null;
  return <section className="sources" aria-label="Sources">
    <div className="source-list">{sources.map(source => {
      const name = source.name;
      const previous = name.endsWith('.previous.jsonl');
      return <div key={name} className="source-item">
        <div className="source-line">
          <i className={`source-dot ${previous ? 'previous-source' : 'current-source'}`} />
          <code className="source-name" title={`Modified: ${formatDate(source.lastModified)} ${formatTime(source.lastModified)} UTC. Imported: ${formatTime(source.importedAt)} UTC.`}>{name}</code>
          <span className="source-counts">{source.nonEmptyLines === 0 ? 'Empty file' : `${source.events.length.toLocaleString('en-US')} ${source.events.length === 1 ? 'check' : 'checks'}`}</span>
          <button className="icon-button" disabled={disabled} title={`Reload ${name}`} aria-label={`Reload ${name}`} onClick={() => onChoose(name)}><RotateCcw size={14} /></button>
          <button className="icon-button" disabled={disabled} title={`Remove ${name}`} aria-label={`Remove ${name}`} onClick={() => onRemove(name)}><X size={14} /></button>
        </div>
        {source.origin && <p className="source-origin" title={source.origin.label}>{source.origin.label}</p>}
        {source.issues.length > 0 && <details className="source-issues"><summary>{source.issues.length} {source.issues.length === 1 ? 'line' : 'lines'} skipped</summary><ul>{source.issues.slice(0, 50).map(issue => <li key={issue.line}><span>L{issue.line}</span>{issueLabel(issue)}</li>)}</ul>{source.issues.length > 50 && <p>First 50 of {source.issues.length} skipped lines.</p>}</details>}
      </div>;
    })}</div>
  </section>;
}