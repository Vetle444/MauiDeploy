import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, ChartColumn, Files, FlaskConical, Info, List, RefreshCw, Trash2, X } from 'lucide-react';
import { chronologicalEvents, isSourceName, parseJsonl, replaceSources, summarizeRootTypes } from './diagnostics';
import type { ImportedSource, SourceName } from './diagnostics';
import { CheckDetails, CheckSequence, EventList, Overview, RootSummaryList } from './Inspection';
import { SourcePanel } from './SourcePanel';
import { createSampleSources } from './sample';
import { deviceBridge, isDeviceImportMessage } from './deviceImport';
import type { DeviceImportMessage } from './deviceImport';

type InspectionView = { kind: 'summary' } | { kind: 'checks'; rootType?: string };

function revealSection(element: HTMLElement | null) {
  if (!element) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  element.focus({ preventScroll: true });
}

export default function App() {
  const [sources, setSources] = useState<ImportedSource[]>([]);
  const [view, setView] = useState<InspectionView>({ kind: 'summary' });
  const [selectedId, setSelectedId] = useState<string>();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [loadingOrigin, setLoadingOrigin] = useState<string>();
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileMenu = useRef<HTMLDetailsElement>(null);
  const importLock = useRef(false);
  const importGeneration = useRef(0);
  const latestDeviceRequest = useRef(0);
  const activeDeviceRequest = useRef<number | undefined>(undefined);
  const requestedSource = useRef<SourceName | undefined>(undefined);
  const dragDepth = useRef(0);
  const detailElement = useRef<HTMLElement>(null);
  const listElement = useRef<HTMLElement>(null);
  const events = chronologicalEvents(sources);
  let visibleEvents = events;
  if (view.kind === 'checks' && view.rootType) {
    visibleEvents = events.filter(event => event.rootType === view.rootType);
  }
  const rootSummaries = summarizeRootTypes(visibleEvents);
  const pageSize = 20;
  const itemCount = view.kind === 'summary' ? rootSummaries.length : visibleEvents.length;
  const pageCount = Math.max(1, Math.ceil(itemCount / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageEvents = visibleEvents.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const pageSummaries = rootSummaries.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selected = visibleEvents.find(event => event.id === selectedId);
  const skipped = sources.reduce((total, source) => total + source.issues.length, 0);
  const sample = sources.some(source => source.id.startsWith('sample-'));
  const refreshFromDevice = Boolean(deviceBridge) && sources.every(source => source.origin);

  const receiveDeviceImport = useEffectEvent((message: DeviceImportMessage) => {
    if (message.requestId < latestDeviceRequest.current) return;
    if (message.type === 'deviceImportLoading') {
      if (message.requestId > latestDeviceRequest.current) importGeneration.current++;
      latestDeviceRequest.current = message.requestId;
      activeDeviceRequest.current = message.requestId;
      importLock.current = true;
      setBusy(true);
      setDeviceLoading(true);
      setLoadingOrigin(message.origin?.label);
      setNotice('');
      return;
    }
    if (activeDeviceRequest.current !== message.requestId) return;
    activeDeviceRequest.current = undefined;
    importLock.current = false;
    setBusy(false);
    setDeviceLoading(false);
    if (message.type === 'deviceImportError') {
      setNotice(message.message);
      return;
    }
    const importedAt = Date.now();
    const incoming = message.files.map(file => parseJsonl(file.content, {
      id: crypto.randomUUID(), name: file.name, size: new TextEncoder().encode(file.content).length,
      lastModified: file.lastModified, importedAt, origin: message.origin,
    }));
    setSources(replaceSources([], incoming));
    setView({ kind: 'summary' });
    setSelectedId(undefined);
    setPage(0);
    setNotice('');
  });

  useEffect(() => {
    if (!deviceBridge) return;
    const receive = (event: MessageEvent) => {
      if (isDeviceImportMessage(event.data)) receiveDeviceImport(event.data);
    };
    window.addEventListener('message', receive);
    deviceBridge.postMessage({ type: 'deviceImportReady' });
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (!selectedId || !window.matchMedia('(max-width: 900px)').matches) return;
    revealSection(detailElement.current);
  }, [selectedId]);

  function chooseFiles(name?: SourceName) {
    if (!fileInput.current || importLock.current) return;
    requestedSource.current = name;
    fileInput.current.multiple = !name;
    fileInput.current.click();
  }

  function refreshSources() {
    if (importLock.current) return;
    if (refreshFromDevice) {
      deviceBridge?.postMessage({ type: 'deviceImportRefresh' });
      return;
    }
    chooseFiles();
  }

  async function importFiles(files: File[], expectedName?: SourceName) {
    if (files.length === 0 || importLock.current) return;
    const names = files.map(file => file.name);
    if (new Set(names).size !== names.length) {
      setNotice('More than one copy of the same filename was selected. No files were replaced.');
      return;
    }
    if (expectedName && files.some(file => file.name !== expectedName)) {
      setNotice(`Expected ${expectedName}. The existing source has not been replaced.`);
      return;
    }
    importLock.current = true;
    const generation = ++importGeneration.current;
    setBusy(true);
    setNotice('');
    const incoming: ImportedSource[] = [];
    const messages: string[] = [];
    try {
      for (const file of files) {
        if (!isSourceName(file.name)) {
          messages.push('Select checks-*.jsonl files (including .previous.jsonl copies), checks.jsonl or checks.previous.jsonl.');
          continue;
        }
        try {
          const content = await file.text();
          incoming.push(parseJsonl(content, {
            id: crypto.randomUUID(), name: file.name, size: file.size,
            lastModified: file.lastModified, importedAt: Date.now(),
          }));
        } catch {
          messages.push(`${file.name} could not be read. Its existing data has been kept.`);
        }
      }
      if (generation !== importGeneration.current) return;
      if (incoming.length > 0) {
        startTransition(() => {
          setSources(current => replaceSources(current.filter(source => !source.id.startsWith('sample-')), incoming));
          setView({ kind: 'summary' });
          setSelectedId(undefined);
          setPage(0);
        });
      }
      setNotice([...new Set(messages)].join(' '));
    } finally {
      if (generation === importGeneration.current) {
        importLock.current = false;
        setBusy(false);
      }
    }
  }

  function clearSession() {
    setSources([]);
    setNotice('');
    changeView({ kind: 'summary' });
  }

  function loadSample() {
    setSources(createSampleSources());
    setNotice('');
    changeView({ kind: 'summary' });
  }

  function changeView(next: InspectionView) {
    setView(next);
    setSelectedId(undefined);
    setPage(0);
  }

  function inspectSequenceCheck(id: string) {
    const index = events.findIndex(event => event.id === id);
    if (index === -1) return;
    setView({ kind: 'checks' });
    setPage(Math.floor(index / pageSize));
    setSelectedId(id);
  }

  function emptyTitle() {
    if (sources.length === 0) return 'No diagnostic files';
    if (events.length > 0) return 'No checks';
    if (sources.every(source => source.nonEmptyLines === 0)) return 'Empty files';
    return 'No supported checks';
  }

  return (
    <div className="app" aria-busy={busy}
      onPointerDown={event => {
        if (fileMenu.current && !fileMenu.current.contains(event.target as Node)) fileMenu.current.open = false;
      }}
      onDragEnter={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={event => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDragLeave={event => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={event => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void importFiles(Array.from(event.dataTransfer.files));
      }}>
      <input ref={fileInput} type="file" accept=".jsonl" multiple hidden aria-label="Diagnostic files"
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void importFiles(files, requestedSource.current);
        }} />

      {notice && <div className="notice" role="alert"><Info size={17} /><span>{notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice('')}><X size={16} /></button></div>}
      {deviceLoading && <div className="notice device-loading" role="status"><ArrowDownToLine size={17} /><span>Reading diagnostics from {loadingOrigin ?? 'the selected app and device'}...</span><button className="icon-button" title="Cancel device import" aria-label="Cancel device import" onClick={() => deviceBridge?.postMessage({ type: 'deviceImportCancel' })}><X size={16} /></button></div>}

      <main className="workspace">
        <h1 className="sr-only">DUI Memory</h1>
        {events.length > 0 && <Overview events={visibleEvents} total={events.length} rootTypeCount={rootSummaries.length} />}
        {sources.length > 0 && <div className="section-heading events-heading">
          <div className="view-tabs" role="tablist" aria-label="Diagnostic views" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            let kind: InspectionView['kind'];
            if (event.key === 'Home') kind = 'summary';
            else if (event.key === 'End') kind = 'checks';
            else kind = view.kind === 'summary' ? 'checks' : 'summary';
            changeView({ kind });
            event.currentTarget.querySelector<HTMLButtonElement>(`#${kind}-tab`)?.focus();
          }}>
            <button id="summary-tab" role="tab" aria-selected={view.kind === 'summary'} aria-controls="summary-view" tabIndex={view.kind === 'summary' ? 0 : -1} onClick={() => changeView({ kind: 'summary' })}><ChartColumn size={15} /> Summary</button>
            <button id="checks-tab" role="tab" aria-selected={view.kind === 'checks'} aria-controls="checks-view" tabIndex={view.kind === 'checks' ? 0 : -1} onClick={() => changeView({ kind: 'checks' })}><List size={15} /> Checks</button>
          </div>
          <div className="view-actions">
            {sample && <span className="sample-label"><FlaskConical size={13} /> Synthetic sample</span>}
            <button className="text-button" aria-label="Refresh diagnostics" title={refreshFromDevice ? 'Reload JSONL from selected app and device' : 'Reload local JSONL files'} disabled={busy} onClick={refreshSources}><RefreshCw size={16} /> Refresh</button>
            <details ref={fileMenu} className="file-menu" onKeyDown={event => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.currentTarget.open = false;
              event.currentTarget.querySelector('summary')?.focus();
            }}>
              <summary className="icon-button" aria-label="Files" title={skipped > 0 ? `Files: ${skipped} skipped ${skipped === 1 ? 'line' : 'lines'}` : 'Files'}>
                <Files size={17} />{skipped > 0 && <span className="file-warning" aria-hidden="true" />}
              </summary>
              <div className="file-menu-panel">
                <div className="file-actions"><h2>Files</h2><button className="primary-button" disabled={busy} onClick={() => chooseFiles()}><ArrowDownToLine size={16} />{busy ? 'Importing...' : 'Import files'}</button><button className="icon-button" title="Clear session" aria-label="Clear session" disabled={busy} onClick={clearSession}><Trash2 size={16} /></button></div>
                <SourcePanel sources={sources} disabled={busy} onChoose={chooseFiles} onRemove={name => {
                  setSources(current => current.filter(source => source.name !== name));
                  setSelectedId(undefined);
                }} />
              </div>
            </details>
          </div>
        </div>}
          {view.kind === 'checks' && view.rootType && <div className="check-scope"><button className="icon-button" title="Back to summary" aria-label="Back to summary" onClick={() => changeView({ kind: 'summary' })}><ArrowLeft size={16} /></button><code>{view.rootType}</code><span className="count">{visibleEvents.length}</span></div>}
          <div className={`inspection-grid ${selected ? 'has-selection' : ''}`} role={sources.length > 0 ? 'tabpanel' : undefined} id={`${view.kind}-view`} aria-labelledby={sources.length > 0 ? `${view.kind}-tab` : undefined}>
            <section ref={listElement} tabIndex={-1} className="event-section" aria-label={view.kind === 'summary' ? 'Root types' : 'Checks'}>
              {view.kind === 'summary' ? <>
                <CheckSequence events={visibleEvents} onSelect={inspectSequenceCheck} onShowAll={() => changeView({ kind: 'checks' })} />
                <RootSummaryList groups={pageSummaries} onSelect={rootType => changeView({ kind: 'checks', rootType })} />
              </> : <EventList events={pageEvents} selectedId={selected?.id} onSelect={setSelectedId} />}
              {visibleEvents.length === 0 && <div className="empty-state">
                <span className="empty-mascot" aria-hidden="true">&#x1F526;</span>
                <h3>{emptyTitle()}</h3>
                {sources.length === 0 && <>
                  {!deviceBridge && <p>App sandbox files must first be exported to a local folder.</p>}
                  <div className="empty-actions">{deviceBridge && <button className="primary-button" disabled={busy} onClick={refreshSources}><RefreshCw size={16} /> Load from device</button>}<button className="primary-button" disabled={busy} onClick={() => chooseFiles()}><ArrowDownToLine size={16} /> Import files</button><button className="text-button" disabled={busy} onClick={loadSample}><FlaskConical size={15} /> Synthetic sample</button></div>
                  <div className="file-labels"><code>checks-*.jsonl</code><code>checks.previous.jsonl</code><code>checks.jsonl</code></div>
                </>}
                {sources.length > 0 && events.length === 0 && <p>{skipped > 0 ? `${skipped} ${skipped === 1 ? 'line' : 'lines'} skipped.` : 'No non-empty lines were found.'}</p>}
              </div>}
              {itemCount > pageSize && <nav className="pagination" aria-label={view.kind === 'summary' ? 'Root type pages' : 'Check pages'}><span>{currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, itemCount)} of {itemCount}</span><div><button className="icon-button" title="Previous page" aria-label="Previous page" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelectedId(undefined); }}><ArrowUpFromLine size={15} /></button><span>{currentPage + 1} / {pageCount}</span><button className="icon-button" title="Next page" aria-label="Next page" disabled={currentPage + 1 >= pageCount} onClick={() => { setPage(currentPage + 1); setSelectedId(undefined); }}><ArrowDownToLine size={15} /></button></div></nav>}
            </section>
            {selected && <section ref={detailElement} tabIndex={-1} className="detail-section" aria-label="Check details">
              <CheckDetails event={selected} onClose={() => {
                setSelectedId(undefined);
                requestAnimationFrame(() => {
                  revealSection(listElement.current);
                });
              }} />
            </section>}
          </div>
      </main>
      {dragging && <div className="drop-overlay"><ArrowDownToLine size={36} /><strong>Import local copies</strong><span>checks-*.jsonl / checks.previous.jsonl / checks.jsonl</span></div>}
    </div>
  );
}
