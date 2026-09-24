import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckSquare, ChevronRight, LoaderCircle, Monitor, Search, Smartphone, Square, Usb, Wifi } from 'lucide-react';
import { siApple, siAndroid } from 'simple-icons';
import type { ToolboxPick, ToolboxPickItem } from '../../src/toolboxModel';

export type PickerMessage =
  | { type: 'toolboxPickCancel'; id: string }
  | { type: 'toolboxPickInput'; id: string; value: string }
  | { type: 'toolboxPickFocus'; id: string; itemId: string }
  | { type: 'toolboxPickSelection' | 'toolboxPickAccept'; id: string; itemIds: string[] };

export function ToolboxPicker({ picker, send }: { picker: ToolboxPick; send: (message: PickerMessage) => void }) {
  const [query, setQuery] = useState(picker.value);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const queryWords = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible: ToolboxPickItem[] = [];
  let separator: ToolboxPickItem | undefined;
  for (const item of picker.items) {
    if (item.separator) { separator = item; continue; }
    const searchable = [item.label, picker.matchDescription ? item.description : '', picker.matchDetail ? item.detail : ''].join(' ').toLocaleLowerCase();
    if (!item.alwaysShow && !queryWords.every(word => searchable.includes(word))) continue;
    if (separator) { visible.push(separator); separator = undefined; }
    visible.push(item);
  }
  const options = visible.filter(item => !item.separator);
  const activeId = options.find(item => item.id === picker.activeId)?.id ?? options[0]?.id;
  const selected = new Set(picker.selectedIds);
  const listId = `${picker.id}-choices`;

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    list.current?.querySelector(`#choice-${activeId}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  function choose(id: string) {
    if (!picker.enabled || picker.value !== query) return;
    if (!picker.multiple) {
      send({ type: 'toolboxPickAccept', id: picker.id, itemIds: [id] });
      return;
    }
    const itemIds = selected.has(id) ? picker.selectedIds.filter(value => value !== id) : [...picker.selectedIds, id];
    send({ type: 'toolboxPickSelection', id: picker.id, itemIds });
    input.current?.focus();
  }

  return <section className="toolbox-picker" aria-label={picker.title} onKeyDown={event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      send({ type: 'toolboxPickCancel', id: picker.id });
      return;
    }
    if (event.target !== input.current || event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && activeId) { event.preventDefault(); choose(activeId); }
    if (options.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const index = options.findIndex(item => item.id === activeId);
      const next = options[(index + offset + options.length) % options.length];
      send({ type: 'toolboxPickFocus', id: picker.id, itemId: next.id });
    }
  }}>
    <div className="toolbox-picker-heading">
      <button className="icon-button" title="Cancel selection" aria-label="Cancel selection" onClick={() => send({ type: 'toolboxPickCancel', id: picker.id })}><ArrowLeft size={17} /></button>
      <h2>{picker.title}</h2>
      {picker.busy && <LoaderCircle className="toolbox-spinner" size={15} aria-label="Updating choices" />}
    </div>
    <div className="toolbox-picker-search"><Search size={15} />
      <input ref={input} type="search" role="combobox" aria-label="Search choices" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId ? `choice-${activeId}` : undefined} aria-autocomplete="list" autoComplete="off"
        value={query} disabled={!picker.enabled} placeholder={picker.placeholder ?? 'Search...'} onChange={event => {
          setQuery(event.target.value);
          send({ type: 'toolboxPickInput', id: picker.id, value: event.target.value });
        }} />
    </div>
    <div ref={list} id={listId} className="toolbox-picker-list" role="listbox" aria-label={picker.title} aria-multiselectable={picker.multiple}>
      {visible.map(item => item.separator ? <div key={item.id} className="toolbox-picker-separator" role="presentation">{item.label}</div> :
        <button key={item.id} id={`choice-${item.id}`} type="button" role="option" tabIndex={-1} aria-selected={picker.multiple ? selected.has(item.id) : activeId === item.id}
          className={`toolbox-choice ${activeId === item.id ? 'is-focused' : ''}`} disabled={!picker.enabled} title={[item.label, item.description, item.detail].filter(Boolean).join('\n')}
          onClick={() => choose(item.id)}>
          {picker.multiple && <span className="toolbox-choice-check">{selected.has(item.id) ? <CheckSquare size={18} /> : <Square size={18} />}</span>}
          {item.device && <DeviceChoiceIcon device={item.device} />}
          <span className="toolbox-choice-copy"><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}{item.detail && <small>{item.detail}</small>}</span>
          {!picker.multiple && <ChevronRight size={15} />}
        </button>)}
    </div>
    {options.length === 0 && <p className="toolbox-picker-empty" role="status">{picker.busy ? 'Finding choices...' : 'No matching choices'}</p>}
    {picker.multiple && <div className="toolbox-picker-footer"><span>{selected.size} selected</span><button className="primary-button" disabled={!picker.enabled || selected.size === 0} onClick={() => send({ type: 'toolboxPickAccept', id: picker.id, itemIds: picker.selectedIds })}><Check size={16} /> Continue</button></div>}
  </section>;
}

function DeviceChoiceIcon({ device }: { device: NonNullable<ToolboxPickItem['device']> }) {
  const platformIcon = device.platform === 'iOS' ? siApple : siAndroid;
  let BadgeIcon = device.type === 'physical' ? Smartphone : Monitor;
  if (device.transport === 'USB') BadgeIcon = Usb;
  if (device.transport === 'Wi-Fi') BadgeIcon = Wifi;
  let kind = 'physical device';
  if (device.type === 'simulator') kind = device.platform === 'Android' ? 'emulator' : 'simulator';
  const label = [device.platform, kind, device.transport].filter(Boolean).join(' - ');

  return <span className={`toolbox-choice-device platform-${device.platform.toLowerCase()}`} role="img" aria-label={label} title={label}>
    <span className="toolbox-device-symbol">
      <svg className="toolbox-platform-logo" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={platformIcon.path} /></svg>
      <span className="toolbox-device-badge"><BadgeIcon size={11} strokeWidth={2.2} aria-hidden="true" /></span>
    </span>
    <small aria-hidden="true">{device.platform}</small>
  </span>;
}