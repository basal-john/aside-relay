import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Copy, Download, File, FileCode2, FileImage, FileText, Pencil, Trash2 } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { Button } from './Button';
import { Dialog, DialogActions, DialogDescription } from './Dialog';
import { Sheet, ICON_STROKE } from './ui';
import { tokens } from './tokens.stylex';

type Artifact = { name: string; path: string; absolutePath: string; bytes: number; mtime: number; mime: string; kind: 'image' | 'pdf' | 'html' | 'text' | 'csv' | 'binary'; previewUrl: string };

export function Artifacts({ sessionId, request, notify, onClose, onZoom }: {
  sessionId: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  notify: (text: string, kind?: 'error' | 'success') => void;
  onClose: () => void;
  onZoom?: (src: string) => void;
}) {
  const [items, setItems] = useState<Artifact[]>([]);
  const [selected, setSelected] = useState<Artifact>();
  const [textPreview, setTextPreview] = useState('');
  const [isLoading, setLoading] = useState(true);
  const [isRenaming, setRenaming] = useState(false);
  const [isDeleting, setDeleting] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);

  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const response = await request(`/api/native/files/sessions/${encodeURIComponent(sessionId)}/artifacts`, { signal });
      if (!response.ok) throw new Error(await response.text());
      const next = parseArtifacts(await response.json());
      setItems(next);
      setSelected(current => current && next.find(item => item.path === current.path));
    } catch (error) {
      if (!signal?.aborted) notify(error instanceof Error && error.message || 'Could not load files.', 'error');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [sessionId]);
  useEffect(() => {
    if (!selected || !['text', 'csv'].includes(selected.kind)) { setTextPreview(''); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({ path: selected.path });
    request(`/api/native/files/sessions/${encodeURIComponent(sessionId)}/artifact-preview?${params}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(await response.text());
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.content !== 'string') throw new Error('Invalid file preview.');
      setTextPreview(payload.content);
    }).catch(error => { if (!controller.signal.aborted) notify(error instanceof Error ? error.message : 'Could not preview this file.', 'error'); });
    return () => controller.abort();
  }, [request, selected, sessionId]);

  const selectedUrl = selected && `/api/native/files/sessions/${encodeURIComponent(sessionId)}/artifacts/${selected.path.split('/').map(encodeURIComponent).join('/')}`;

  async function rename(name: string) {
    if (!selected || !name.trim()) return;
    setSaving(true);
    try {
      const response = await request(selectedUrl!, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
      if (!response.ok) throw new Error(await response.text());
      setRenaming(false); await load(); notify('File renamed.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not rename this file.', 'error'); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!selected) return;
    setSaving(true);
    try {
      const response = await request(selectedUrl!, { method: 'DELETE' });
      if (!response.ok) throw new Error(await response.text());
      setDeleting(false); setSelected(undefined); await load(); notify('File deleted.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not delete this file.', 'error'); }
    finally { setSaving(false); }
  }

  return <Sheet title="Files" onClose={onClose} isWide>
    <div {...stylex.props(styles.header)}><div><h2 {...stylex.props(styles.title)}>Files</h2><p {...stylex.props(styles.subtitle)}>{items.length} {items.length === 1 ? 'file' : 'files'} from this conversation</p></div>{selected && <div {...stylex.props(styles.actions)}><Button size="compact" onClick={() => { void navigator.clipboard.writeText(selected.absolutePath).then(() => notify('File path copied.', 'success'), () => notify('Could not copy the file path.', 'error')); }}><Copy size={16} />Copy path</Button><Button size="compact" onClick={() => setRenaming(true)}><Pencil size={16} />Rename</Button><Button size="compact" variant="danger" onClick={() => setDeleting(true)}><Trash2 size={16} />Delete</Button></div>}</div>
    <div {...stylex.props(styles.layout)}>
      <div {...stylex.props(styles.list)}>{isLoading && <p role="status" {...stylex.props(styles.empty)}>Loading…</p>}{!isLoading && items.length === 0 && <p {...stylex.props(styles.empty)}>No output files yet.</p>}{items.map(item => <button type="button" key={item.path} aria-current={selected?.path === item.path} {...stylex.props(styles.item, selected?.path === item.path && styles.selectedItem)} onClick={() => setSelected(item)}>{fileIcon(item)}<span {...stylex.props(styles.itemText)}><strong {...stylex.props(styles.itemName)}>{item.name}</strong><small {...stylex.props(styles.itemMeta)}>{formatBytes(item.bytes)} · {new Date(item.mtime).toLocaleString()}</small></span></button>)}</div>
      <div {...stylex.props(styles.preview)}>{selected ? <>
        <div {...stylex.props(styles.previewHeader)}><span title={selected.path} {...stylex.props(styles.previewPath)}>{selected.path}</span><a href={`${selectedUrl}?download=true`} download={selected.name} {...stylex.props(styles.download)}><Download size={17} />Download</a></div>
        {selected.kind === 'image' && (onZoom ? <button type="button" aria-label={`Open ${selected.name}`} {...stylex.props(styles.mediaButton)} onClick={() => onZoom(selectedUrl!)}><img src={selectedUrl} alt={selected.name} {...stylex.props(styles.media)} /></button> : <img src={selectedUrl} alt={selected.name} {...stylex.props(styles.media)} />)}
        {selected.kind === 'pdf' && <iframe src={selectedUrl} title={selected.name} {...stylex.props(styles.frame)} />}
        {selected.kind === 'html' && <iframe src={selectedUrl} title={selected.name} sandbox="" {...stylex.props(styles.frame)} />}
        {selected.kind === 'text' && <pre {...stylex.props(styles.code)}>{textPreview || 'Loading preview…'}</pre>}
        {selected.kind === 'csv' && <CsvPreview content={textPreview} />}
        {selected.kind === 'binary' && <div {...stylex.props(styles.emptyPreview)}><File size={36} /><p {...stylex.props(styles.emptyText)}>This file cannot be previewed here.</p><a href={`${selectedUrl}?download=true`} download={selected.name} {...stylex.props(styles.emptyLink)}>Download file</a></div>}
      </> : <div {...stylex.props(styles.emptyPreview)}><FileText size={36} /><p {...stylex.props(styles.emptyText)}>Select a file to preview it.</p></div>}</div>
    </div>
    <AnimatePresence>{isRenaming && selected && <Dialog title="Rename file" initialFocus={renameInput} onClose={() => setRenaming(false)}><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void rename(String(data.get('name') ?? '')); }}><label {...stylex.props(styles.label)}>File name<input ref={renameInput} name="name" defaultValue={selected.name} {...stylex.props(styles.input)} /></label><DialogActions><Button onClick={() => setRenaming(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={isSaving}>Rename</Button></DialogActions></form></Dialog>}</AnimatePresence>
    <AnimatePresence>{isDeleting && selected && <Dialog title="Delete file?" onClose={() => setDeleting(false)}><DialogDescription>This permanently deletes {selected.name} from this conversation.</DialogDescription><DialogActions><Button onClick={() => setDeleting(false)}>Cancel</Button><Button variant="danger" disabled={isSaving} onClick={() => { void remove(); }}>Delete file</Button></DialogActions></Dialog>}</AnimatePresence>
  </Sheet>;
}

function fileIcon(item: Artifact) {
  const Icon = item.kind === 'image' ? FileImage : item.kind === 'text' || item.kind === 'html' ? FileCode2 : FileText;
  return <Icon size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />;
}

function parseArtifacts(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items.flatMap((item): Artifact[] => {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.path !== 'string' || typeof item.absolutePath !== 'string' || typeof item.bytes !== 'number' || typeof item.mtime !== 'number' || typeof item.mime !== 'string' || typeof item.previewUrl !== 'string' || !['image', 'pdf', 'html', 'text', 'csv', 'binary'].includes(String(item.kind))) return [];
    return [{ name: item.name, path: item.path, absolutePath: item.absolutePath, bytes: item.bytes, mtime: item.mtime, mime: item.mime, previewUrl: item.previewUrl, kind: item.kind as Artifact['kind'] }];
  });
}

function CsvPreview({ content }: { content: string }) {
  if (!content) return <p role="status" {...stylex.props(styles.empty)}>Loading preview…</p>;
  const rows = parseCsv(content).slice(0, 200);
  return <div {...stylex.props(styles.tableWrap)}><table {...stylex.props(styles.table)}><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.slice(0, 50).map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex} {...stylex.props(styles.cell, styles.headingCell)}>{cell}</th> : <td key={cellIndex} {...stylex.props(styles.cell)}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

function parseCsv(content: string) {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') { if (quoted && content[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted; }
    else if (character === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) { if (character === '\r' && content[index + 1] === '\n') index += 1; row.push(cell); rows.push(row); row = []; cell = ''; if (rows.length === 200) break; }
    else cell += character;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

const styles = stylex.create({
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 },
  title: { margin: 0, fontSize: '1.125rem', color: tokens.text },
  subtitle: { margin: '3px 0 0', fontSize: '.75rem', color: tokens.muted },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 },
  layout: { display: 'grid', gridTemplateColumns: 'minmax(180px, .8fr) minmax(0, 1.4fr)', gap: 12, minHeight: 420, '@media (max-width: 620px)': { gridTemplateColumns: '1fr', gridTemplateRows: 'minmax(130px, 32dvh) minmax(220px, 1fr)' } },
  list: { overflowY: 'auto', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 16, minHeight: 0 },
  item: { display: 'flex', alignItems: 'center', width: '100%', minHeight: 58, gap: 10, padding: '8px 10px', borderWidth: 0, borderBottomWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: 'transparent', color: tokens.muted, textAlign: 'left' },
  selectedItem: { backgroundColor: tokens.hover, color: tokens.primary },
  itemText: { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 2 },
  itemName: { color: tokens.text, fontSize: '.8125rem', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemMeta: { color: tokens.muted, fontSize: '.6875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  preview: { display: 'flex', minWidth: 0, minHeight: 0, flexDirection: 'column', overflow: 'hidden', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 16, backgroundColor: tokens.surface },
  previewHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 42, gap: 10, padding: '6px 10px', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, color: tokens.muted, fontSize: '.75rem' },
  previewPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  download: { display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, color: tokens.text, textDecoration: 'none' },
  media: { width: '100%', height: '100%', minHeight: 0, objectFit: 'contain' },
  mediaButton: { display: 'block', flex: 1, minHeight: 0, width: '100%', padding: 0, overflow: 'hidden', borderWidth: 0, backgroundColor: 'transparent' },
  frame: { width: '100%', flex: 1, minHeight: 300, borderWidth: 0, backgroundColor: '#fff' },
  code: { flex: 1, minHeight: 0, margin: 0, padding: 14, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'D2Coding, monospace', fontSize: '.75rem', lineHeight: 1.45, color: tokens.text },
  tableWrap: { flex: 1, minHeight: 0, overflow: 'auto' },
  table: { borderCollapse: 'collapse', minWidth: '100%', color: tokens.text, fontFamily: 'D2Coding, monospace', fontSize: '.75rem' },
  cell: { maxWidth: 280, padding: '6px 8px', overflow: 'hidden', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, textAlign: 'left', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  headingCell: { position: 'sticky', top: 0, backgroundColor: tokens.canvas, fontWeight: 650 },
  empty: { margin: 20, color: tokens.muted, fontSize: '.8125rem', textAlign: 'center' },
  emptyPreview: { display: 'grid', flex: 1, minHeight: 220, placeItems: 'center', alignContent: 'center', gap: 8, color: tokens.muted, textAlign: 'center' },
  emptyText: { margin: 0 },
  emptyLink: { color: tokens.primary },
  label: { display: 'flex', flexDirection: 'column', gap: 8, color: tokens.muted, fontSize: '.8125rem' },
  input: { width: '100%', minHeight: 44, padding: '10px 12px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 12, backgroundColor: tokens.canvas, color: tokens.text, fontSize: '1rem' },
});
