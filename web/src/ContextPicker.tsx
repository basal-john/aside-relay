import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeft, File, Folder, FolderOpen, Globe2, ImagePlus, Search, Sparkles } from 'lucide-react';
import { Button } from './Button';
import { Sheet, ICON_STROKE } from './ui';
import { tokens } from './tokens.stylex';

export type ContextReference = { kind: 'tab' | 'file' | 'folder' | 'skill'; label: string; value: string };
export type ContextSkill = { name: string; path: string; description?: string };

type NativeRoot = { id: string; name: string; path: string };
type NativeEntry = { name: string; path: string; absolutePath: string; kind: 'file' | 'folder'; bytes?: number; mime?: string };
type Tab = { targetId: string; title: string; url: string };

export function ContextPicker({ request, sessionId, skills = [], onSelect, onChooseFiles, onChooseFolder, onClose }: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  sessionId?: string;
  skills?: ContextSkill[];
  onSelect: (reference: ContextReference) => void;
  onChooseFiles: () => void;
  onChooseFolder: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [roots, setRoots] = useState<NativeRoot[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [nativeSkills, setNativeSkills] = useState<ContextSkill[]>([]);
  const [location, setLocation] = useState<{ root: NativeRoot; path: string }>();
  const [entries, setEntries] = useState<NativeEntry[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const session = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
    Promise.all([
      request(`/api/native/files/roots${session}`, { signal: controller.signal }).then(readJson),
      request(`/api/tabs${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`, { signal: controller.signal }).then(readJson),
      request('/api/native/workspace/skills', { signal: controller.signal }).then(readJson).catch(() => []),
    ]).then(([rootPayload, tabPayload, skillPayload]) => {
      setRoots(parseRoots(rootPayload));
      setTabs(parseTabs(tabPayload));
      setNativeSkills(parseSkills(skillPayload));
      setError('');
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load context.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, sessionId]);

  useEffect(() => {
    if (!location) { setEntries([]); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({ root: location.root.id, path: location.path });
    if (sessionId) params.set('session', sessionId);
    setLoading(true);
    request(`/api/native/files/browse?${params}`, { signal: controller.signal }).then(readJson).then(payload => {
      setEntries(parseEntries(payload)); setError('');
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not open this folder.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [location, request, sessionId]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTabs = tabs.filter(tab => `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(normalizedQuery));
  const selectableSkills = [...nativeSkills, ...skills].filter((skill, index, items) => items.findIndex(item => item.path === skill.path) === index);
  const visibleSkills = selectableSkills.filter(skill => `${skill.name} ${skill.description ?? ''}`.toLocaleLowerCase().includes(normalizedQuery));
  const visibleEntries = entries.filter(entry => entry.name.toLocaleLowerCase().includes(normalizedQuery));

  function choose(reference: ContextReference) { onSelect(reference); onClose(); }

  return <Sheet title="Add to message" onClose={onClose} isWide>
    <div {...stylex.props(styles.header)}>
      <div {...stylex.props(styles.titleRow)}>{location && <button type="button" aria-label="Back" {...stylex.props(styles.iconButton)} onClick={() => {
        if (!location.path) { setLocation(undefined); return; }
        setLocation({ ...location, path: location.path.split('/').slice(0, -1).join('/') });
      }}><ArrowLeft size={20} strokeWidth={ICON_STROKE} /></button>}<div><h2 {...stylex.props(styles.title)}>{location ? location.root.name : 'Add to message'}</h2>{location?.path && <p {...stylex.props(styles.path)}>{location.path}</p>}</div></div>
      <div {...stylex.props(styles.actions)}><Button size="compact" onClick={() => { onChooseFiles(); onClose(); }}><ImagePlus size={17} />Upload files</Button><Button size="compact" onClick={() => { onChooseFolder(); onClose(); }}><FolderOpen size={17} />Upload folder</Button></div>
    </div>
    <label {...stylex.props(styles.search)}><Search size={18} strokeWidth={ICON_STROKE} aria-hidden="true" /><span {...stylex.props(styles.srOnly)}>Search context</span><input autoFocus value={query} placeholder="Search tabs, files, and skills" {...stylex.props(styles.searchInput)} onChange={event => setQuery(event.target.value)} /></label>
    {error && <p role="status" {...stylex.props(styles.error)}>{error}</p>}
    <div {...stylex.props(styles.list)}>
      {location ? visibleEntries.map(entry => <div key={entry.path} {...stylex.props(styles.entry)}><button type="button" {...stylex.props(styles.entryMain)} onClick={() => {
        if (entry.kind === 'folder') { setQuery(''); setLocation({ ...location, path: entry.path }); return; }
        choose({ kind: 'file', label: entry.name, value: `[@file](${entry.absolutePath})` });
      }}>{entry.kind === 'folder' ? <Folder size={19} /> : <File size={19} />}<span {...stylex.props(styles.rowText)}><strong {...stylex.props(styles.rowTitle)}>{entry.name}</strong><small {...stylex.props(styles.rowMeta)}>{entry.kind === 'folder' ? 'Folder' : formatBytes(entry.bytes)}</small></span></button>{entry.kind === 'folder' && <Button size="compact" onClick={() => choose({ kind: 'folder', label: entry.name, value: `[@folder](${entry.absolutePath})` })}>Add</Button>}</div>) : <>
        {roots.filter(root => root.name.toLocaleLowerCase().includes(normalizedQuery)).map(root => <button type="button" key={root.id} {...stylex.props(styles.row)} onClick={() => { setQuery(''); setLocation({ root, path: '' }); }}><Folder size={19} /><span {...stylex.props(styles.rowText)}><strong {...stylex.props(styles.rowTitle)}>{root.name}</strong><small {...stylex.props(styles.rowMeta)}>{root.path}</small></span></button>)}
        {visibleTabs.map(tab => <button type="button" key={tab.targetId} {...stylex.props(styles.row)} onClick={() => choose({ kind: 'tab', label: tab.title || tab.url, value: `[@tab "${tab.title || 'Untitled tab'}"](${tab.url})` })}><Globe2 size={19} /><span {...stylex.props(styles.rowText)}><strong {...stylex.props(styles.rowTitle)}>{tab.title || 'Untitled tab'}</strong><small {...stylex.props(styles.rowMeta)}>{tab.url}</small></span></button>)}
        {visibleSkills.map(skill => <button type="button" key={skill.path} {...stylex.props(styles.row)} onClick={() => choose({ kind: 'skill', label: skill.name, value: `[@skill "${skill.name}"](${skill.path})` })}><Sparkles size={19} /><span {...stylex.props(styles.rowText)}><strong {...stylex.props(styles.rowTitle)}>{skill.name}</strong><small {...stylex.props(styles.rowMeta)}>{skill.description || skill.path}</small></span></button>)}
      </>}
      {!isLoading && !error && (location ? visibleEntries.length === 0 : roots.length + visibleTabs.length + visibleSkills.length === 0) && <p {...stylex.props(styles.empty)}>No matching context.</p>}
      {isLoading && <p role="status" {...stylex.props(styles.empty)}>Loading…</p>}
    </div>
  </Sheet>;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status}).`);
  return response.json();
}

function parseRoots(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items.flatMap((item): NativeRoot[] => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string' ? [{ id: item.id, name: item.name, path: item.path }] : []);
}

function parseTabs(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return [];
  return value.tabs.flatMap((item): Tab[] => isRecord(item) && typeof item.targetId === 'string' && typeof item.url === 'string' ? [{ targetId: item.targetId, title: typeof item.title === 'string' ? item.title : '', url: item.url }] : []);
}

function parseEntries(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items.flatMap((item): NativeEntry[] => isRecord(item) && typeof item.name === 'string' && typeof item.path === 'string' && typeof item.absolutePath === 'string' && (item.kind === 'file' || item.kind === 'folder') ? [{ name: item.name, path: item.path, absolutePath: item.absolutePath, kind: item.kind, bytes: typeof item.bytes === 'number' ? item.bytes : undefined, mime: typeof item.mime === 'string' ? item.mime : undefined }] : []);
}

function parseSkills(value: unknown) {
  const items = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return items.flatMap((item): ContextSkill[] => isRecord(item) && item.enabled !== false && typeof item.name === 'string' && typeof item.path === 'string' ? [{ name: item.name, path: item.path, description: typeof item.description === 'string' ? item.description : undefined }] : []);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function formatBytes(bytes?: number) { return bytes == null ? 'File' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

const styles = stylex.create({
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  title: { margin: 0, fontSize: '1.125rem', lineHeight: 1.3, color: tokens.text },
  path: { margin: '2px 0 0', maxWidth: 320, color: tokens.muted, fontSize: '.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  actions: { display: 'flex', alignItems: 'center', gap: 6 },
  iconButton: { display: 'grid', placeItems: 'center', width: 40, height: 40, flexShrink: 0, borderWidth: 0, borderRadius: '50%', color: tokens.text, backgroundColor: 'transparent' },
  search: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 12px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 14, backgroundColor: tokens.surface, color: tokens.muted },
  searchInput: { width: '100%', minWidth: 0, borderWidth: 0, padding: 0, backgroundColor: 'transparent', color: tokens.text, fontSize: '.9375rem' },
  list: { display: 'flex', flexDirection: 'column', minHeight: 180, maxHeight: 'min(60dvh, 560px)', marginTop: 12, overflowY: 'auto', overscrollBehavior: 'contain' },
  row: { display: 'flex', alignItems: 'center', width: '100%', minHeight: 56, gap: 12, padding: '8px 10px', borderWidth: 0, borderBottomWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: 'transparent', color: tokens.muted, textAlign: 'left' },
  entry: { display: 'flex', alignItems: 'center', width: '100%', minHeight: 56, gap: 6, paddingRight: 8, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border },
  entryMain: { display: 'flex', flex: 1, alignItems: 'center', minWidth: 0, minHeight: 55, gap: 12, padding: '8px 10px', borderWidth: 0, backgroundColor: 'transparent', color: tokens.muted, textAlign: 'left' },
  rowText: { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 2, color: tokens.text, overflow: 'hidden' },
  rowTitle: { fontSize: '.875rem', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowMeta: { fontSize: '.75rem', color: tokens.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { margin: '24px 0', color: tokens.muted, fontSize: '.875rem', textAlign: 'center' },
  error: { margin: '10px 0 0', color: tokens.danger, fontSize: '.8125rem' },
  srOnly: { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', borderWidth: 0 },
});
