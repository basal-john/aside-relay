import { useCallback, useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { motion, useReducedMotion } from 'motion/react';
import { Virtuoso } from 'react-virtuoso';
import { ArrowDownUp, ChevronRight, Ellipsis, EyeOff, Grid2X2, List, Pin, Plus, Search, Settings2, X } from 'lucide-react';
import type { ChatSession, SessionSettings, UseChat } from './types';
import type { SessionMenuTarget } from './SessionMenu';
import { tokens } from './tokens.stylex';
import { ICON_STROKE, SESSION_CHANGE_EVENT, AsideIcon, BrowserIcon, IconButton, styles as ui } from './ui';
import { Button } from './Button';
import { useAutoRefresh } from './useAutoRefresh';

const RECENT_CONVERSATION_LIMIT = 3;
const NATIVE_PAGE_SIZE = 50;
const NATIVE_REFRESH_INTERVAL_MS = 5_000;
type Project = { id: string; name: string };
type StatusFilter = '' | 'running' | 'suspended' | 'idle' | 'interrupted' | 'errored';
type SidebarSession = ChatSession & { archived?: boolean; projectId?: string; statusLabel?: string; suspensionKind?: string };
type SidebarRow = { kind: 'heading'; group: string } | { kind: 'session'; session: SidebarSession } | { kind: 'more' };

export function Sidebar({ chat, isDrawer, onClose, onNew, onNewIncognito, onOpen, onSettings, onBrowser, onMenu }: {
  chat: UseChat; isDrawer?: boolean; onClose?: () => void; onNew: () => void; onNewIncognito?: () => void; onOpen: (id: string) => void; onSettings: () => void; onBrowser: () => void; onMenu: (target: SessionMenuTarget) => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  const [isShowingAll, setShowingAll] = useState(false);
  const [recentLimit, setRecentLimit] = useState(RECENT_CONVERSATION_LIMIT);
  useEffect(() => {
    if (!chat.isReady || chat.authError) return;
    const controller = new AbortController();
    async function refreshPreference() {
      try {
        const response = await chat.request('/api/native/workspace/preferences', { signal: controller.signal });
        const value: unknown = await response.json();
        const limit = typeof value === 'object' && value !== null ? Reflect.get(value, 'sidebarRecentChatLimit') : undefined;
        if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50) setRecentLimit(limit);
      } catch { /* Preserve the last known preference while disconnected. */ }
    }
    void refreshPreference();
    window.addEventListener('aside:preferences-changed', refreshPreference);
    return () => { controller.abort(); window.removeEventListener('aside:preferences-changed', refreshPreference); };
  }, [chat.request, chat.isReady, chat.authError]);
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [layout, setLayout] = useState<'list' | 'card'>('list');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [projectId, setProjectId] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [nativeSessions, setNativeSessions] = useState<SidebarSession[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoadingNative, setLoadingNative] = useState(false);
  const [isLoadingMoreNative, setLoadingMoreNative] = useState(false);
  const [nativeError, setNativeError] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const chatSessionsRef = useRef(chat.sessions);
  const nativeSessionsRef = useRef(nativeSessions);
  const pendingSettingsRef = useRef(new Map<string, SessionSettings>());
  const nativeQueryRef = useRef('');
  const activeQueryRef = useRef('');
  const loadMoreControllerRef = useRef<AbortController | undefined>(undefined);
  chatSessionsRef.current = chat.sessions;
  nativeSessionsRef.current = nativeSessions;
  const activeQuery = nativeQueryKey({ view, sort, projectId, status: statusFilter, query: chat.searchQuery });
  activeQueryRef.current = activeQuery;
  const isExpanded = isShowingAll || !!chat.searchQuery.trim();
  const pinnedSessions = chat.sessions.filter(session => !session.archived && session.isPinned);
  const recentSessions = chat.sessions.filter(session => !session.archived && !session.isPinned);
  const chatSessionsRevision = chat.sessions.map(session => `${session.id}:${session.status}:${Number(session.unread)}:${session.mtime}`).join('|');
  const loadNative = useCallback(async (signal: AbortSignal) => {
    if (!isExpanded) return;
    setLoadingNative(true); setNativeError(false);
    try {
      const queryKey = activeQuery;
      const targetCount = nativeQueryRef.current === queryKey ? Math.max(NATIVE_PAGE_SIZE, nativeSessionsRef.current.length) : NATIVE_PAGE_SIZE;
      nativeQueryRef.current = queryKey;
      let cursor = 0; let next: number | null = 0; const items: SidebarSession[] = [];
      while (next != null && items.length < targetCount) {
        const limit = Math.min(200, targetCount - items.length);
        const response = await chat.request(nativeSessionsUrl({ view, sort, projectId, status: statusFilter, query: chat.searchQuery, cursor, limit }), { cache: 'no-store', signal });
        const result = readNativePage(await response.json(), view === 'archived');
        items.push(...result.items); next = result.nextCursor; cursor = result.nextCursor ?? cursor;
      }
      if (!signal.aborted) { setNativeSessions(items.map(item => ({ ...item, ...pendingSettingsRef.current.get(item.id) }))); setNextCursor(next); }
    } catch {
      if (signal.aborted) return;
      const canUseFallback = view === 'active' && !projectId && !statusFilter && !chat.searchQuery.trim();
      setNativeError(!canUseFallback);
      setNativeSessions(canUseFallback ? chatSessionsRef.current : []);
      setNextCursor(null);
    } finally { if (!signal.aborted) setLoadingNative(false); }
  }, [activeQuery, chat.request, chat.searchQuery, chatSessionsRevision, isExpanded, projectId, refreshRevision, sort, statusFilter, view]);
  useAutoRefresh(loadNative, NATIVE_REFRESH_INTERVAL_MS, isExpanded);
  useEffect(() => {
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = undefined;
    setLoadingMoreNative(false);
  }, [activeQuery]);
  useEffect(() => () => loadMoreControllerRef.current?.abort(), []);
  useEffect(() => {
    const refresh = (event: Event) => {
      if (event instanceof CustomEvent) {
        const detail: unknown = event.detail;
        if (typeof detail === 'object' && detail !== null && 'id' in detail && typeof detail.id === 'string' && 'settings' in detail && typeof detail.settings === 'object' && detail.settings !== null) {
          const value = detail.settings;
          const settings: SessionSettings = {
            ...('title' in value && typeof value.title === 'string' ? { title: value.title } : {}),
            ...('isPinned' in value && typeof value.isPinned === 'boolean' ? { isPinned: value.isPinned } : {}),
            ...('unread' in value && typeof value.unread === 'boolean' ? { unread: value.unread } : {}),
            ...('archived' in value && typeof value.archived === 'boolean' ? { archived: value.archived } : {}),
          };
          if ('isPending' in detail && detail.isPending === true) pendingSettingsRef.current.set(detail.id, { ...pendingSettingsRef.current.get(detail.id), ...settings });
          else pendingSettingsRef.current.delete(detail.id);
          setNativeSessions(current => current.map(session => session.id === detail.id ? { ...session, ...settings } : session));
        }
      }
      setRefreshRevision(current => current + 1);
    };
    window.addEventListener(SESSION_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(SESSION_CHANGE_EVENT, refresh);
  }, []);
  useEffect(() => {
    if (!isShowingAll) return;
    const controller = new AbortController();
    void chat.request('/api/native/projects', { cache: 'no-store', signal: controller.signal }).then(response => response.json()).then(value => { if (!controller.signal.aborted) setProjects(readProjects(value)); }).catch(() => undefined);
    return () => controller.abort();
  }, [chat.request, isShowingAll]);
  const visibleSessions: SidebarSession[] = isExpanded ? nativeSessions.filter(session => !!session.archived === (view === 'archived')) : [...pinnedSessions, ...recentSessions.slice(0, recentLimit)];
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const hasLongPressed = useRef(false);
  useEffect(() => cancelPress, []);
  function cancelPress() { if (press.current) clearTimeout(press.current.timer); press.current = undefined; }
  async function loadMoreNative() {
    if (nextCursor == null || isLoadingMoreNative) return;
    const queryKey = activeQuery;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    setLoadingMoreNative(true);
    try {
      const response = await chat.request(nativeSessionsUrl({ view, sort, projectId, status: statusFilter, query: chat.searchQuery, cursor: nextCursor, limit: NATIVE_PAGE_SIZE }), { cache: 'no-store', signal: controller.signal });
      const result = readNativePage(await response.json(), view === 'archived');
      if (controller.signal.aborted || activeQueryRef.current !== queryKey) return;
      setNativeSessions(current => [...current, ...result.items.filter(item => !current.some(existing => existing.id === item.id)).map(item => ({ ...item, ...pendingSettingsRef.current.get(item.id) }))]);
      setNextCursor(result.nextCursor);
    } catch { if (!controller.signal.aborted && activeQueryRef.current === queryKey) setNativeError(true); }
    finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = undefined;
        setLoadingMoreNative(false);
      }
    }
  }
  function targetFor(element: EventTarget) {
    if (!(element instanceof Element)) return;
    const anchor = element.closest<HTMLElement>('button[data-session-id]');
    const session = visibleSessions.find(session => session.id === anchor?.dataset.sessionId);
    return anchor && session ? { id: session.id, title: session.title, anchor, archived: session.archived, projectId: session.projectId, unread: session.unread, status: session.status } : undefined;
  }
  let lastGroup = '';
  const rows: SidebarRow[] = visibleSessions.flatMap(session => {
    const group = view === 'active' && session.isPinned ? 'Pinned' : dateGroup(session.mtime); const hasHeading = group !== lastGroup; lastGroup = group;
    return [...(hasHeading ? [{ kind: 'heading' as const, group }] : []), { kind: 'session' as const, session }];
  });
  if (isExpanded && (nextCursor != null || isLoadingMoreNative)) rows.push({ kind: 'more' });
  return <aside {...stylex.props(styles.sidebar)} aria-label="Conversations" onPointerDown={event => {
    cancelPress(); hasLongPressed.current = false;
    if (event.button !== 0 || !event.isPrimary) return;
    const target = targetFor(event.target); if (!target) return;
    const { clientX: x, clientY: y } = event;
    press.current = { x, y, timer: setTimeout(() => { hasLongPressed.current = true; window.getSelection()?.removeAllRanges(); onMenu({ ...target, point: { x, y } }); cancelPress(); }, 500) };
  }} onPointerMove={event => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) cancelPress(); }} onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress} onClickCapture={event => { if (hasLongPressed.current) { event.preventDefault(); event.stopPropagation(); hasLongPressed.current = false; } }} onContextMenu={event => {
    const target = targetFor(event.target); if (!target) return;
    event.preventDefault(); cancelPress(); hasLongPressed.current = true; onMenu({ ...target, point: { x: event.clientX, y: event.clientY } });
  }} onKeyDown={event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const target = targetFor(event.target); if (!target) return;
    event.preventDefault(); onMenu(target);
  }}>
    <div {...stylex.props(styles.top)}><span {...stylex.props(styles.brand)}><AsideIcon size={24} />Aside</span>{isDrawer && <IconButton label="Close conversations" onClick={onClose}><X size={22} strokeWidth={ICON_STROKE} /></IconButton>}</div>
    <div {...stylex.props(styles.newChatRow)}><button {...stylex.props(styles.newChat)} onClick={onNew}><Plus size={20} strokeWidth={ICON_STROKE} />New chat</button>{onNewIncognito && <IconButton label="New incognito chat" onClick={onNewIncognito}><EyeOff size={19} strokeWidth={ICON_STROKE} /></IconButton>}</div>
    <div {...stylex.props(styles.search)}><Search size={17} strokeWidth={ICON_STROKE} /><input aria-label="Search conversations" placeholder="Search" value={chat.searchQuery} onChange={event => chat.setSearchQuery(event.target.value)} {...stylex.props(styles.searchInput)} />{chat.searchQuery && <button {...stylex.props(styles.clear)} aria-label="Clear search" onClick={() => chat.setSearchQuery('')}><X size={16} /></button>}</div>
    {isShowingAll && <div {...stylex.props(styles.controls)}>
      <div {...stylex.props(styles.segment)}><button type="button" aria-pressed={view === 'active'} {...stylex.props(styles.control, view === 'active' && styles.activeControl)} onClick={() => setView('active')}>Chats</button><button type="button" aria-pressed={view === 'archived'} {...stylex.props(styles.control, view === 'archived' && styles.activeControl)} onClick={() => setView('archived')}><span>Archive</span></button></div>
      <select aria-label="Filter by project" value={projectId} {...stylex.props(styles.projectFilter)} onChange={event => setProjectId(event.target.value)}><option value="">All projects</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <select aria-label="Filter by status" value={statusFilter} {...stylex.props(styles.projectFilter)} onChange={event => setStatusFilter(event.target.value as StatusFilter)}><option value="">All statuses</option><option value="running">Running</option><option value="suspended">Needs attention</option><option value="idle">Completed</option><option value="interrupted">Interrupted</option><option value="errored">Failed</option></select>
      <IconButton label={sort === 'newest' ? 'Newest first' : 'Oldest first'} onClick={() => setSort(current => current === 'newest' ? 'oldest' : 'newest')}><ArrowDownUp size={17} strokeWidth={ICON_STROKE} /></IconButton>
      <IconButton label={layout === 'list' ? 'Card view' : 'List view'} onClick={() => setLayout(current => current === 'list' ? 'card' : 'list')}>{layout === 'list' ? <Grid2X2 size={17} strokeWidth={ICON_STROKE} /> : <List size={17} strokeWidth={ICON_STROKE} />}</IconButton>
    </div>}
    <div {...stylex.props(styles.list)}>
      {rows.length > 0 && <Virtuoso data={rows} initialItemCount={12} defaultItemHeight={layout === 'card' ? 76 : 50} increaseViewportBy={150} style={{ height: '100%' }} computeItemKey={(_, row) => row.kind === 'heading' ? row.group : row.kind === 'more' ? 'load-more' : row.session.id} components={recentSessionListComponents} itemContent={(_, row) => {
        if (row.kind === 'heading') return <h2 {...stylex.props(styles.group)}>{row.group}</h2>;
        if (row.kind === 'more') return <Button {...stylex.props(styles.more)} disabled={isLoadingMoreNative} onClick={() => { void loadMoreNative(); }}>{isLoadingMoreNative ? 'Loading…' : 'Show more'}<ChevronRight size={16} /></Button>;
        const session = row.session;
        const isRunning = session.status === 'running' || session.id === chat.sessionId && chat.isRunning;
        const needsAttention = !!session.suspensionKind || session.status === 'suspended' || session.status === 'waiting';
        return <div {...stylex.props(styles.session, layout === 'card' && styles.card, session.id === chat.sessionId && styles.selected)}>
          <button data-session-id={session.id} {...stylex.props(styles.sessionButton, layout === 'card' && styles.cardButton)} title={session.statusLabel ? `${session.title || 'Untitled conversation'} · ${session.statusLabel}` : session.title || 'Untitled conversation'} aria-current={session.id === chat.sessionId ? 'page' : undefined} onClick={() => onOpen(session.id)}><span {...stylex.props(styles.sessionCopy)}><span {...stylex.props(styles.sessionTitle)}>{session.title || 'Untitled conversation'}</span>{layout === 'card' && session.statusLabel && <span {...stylex.props(styles.statusLabel)}>{session.statusLabel}</span>}</span>{session.isPinned && <Pin {...stylex.props(styles.pin)} size={13} strokeWidth={ICON_STROKE} aria-label="Pinned" />}{isRunning ? <span {...stylex.props(styles.status)} role="img" aria-label="Running"><motion.span {...stylex.props(styles.spinner)} aria-hidden="true" animate={shouldReduceMotion ? undefined : { rotate: 360 }} transition={{ duration: .8, repeat: Infinity, ease: 'linear' }} /></span> : needsAttention ? <span {...stylex.props(styles.status)} role="img" aria-label={session.statusLabel || 'Needs attention'}><span {...stylex.props(styles.attention)} /></span> : session.status === 'errored' ? <span {...stylex.props(styles.status)} role="img" aria-label={session.statusLabel || 'Task failed'}><span {...stylex.props(styles.failed)} /></span> : session.unread && session.id !== chat.sessionId ? <span {...stylex.props(styles.status)} role="img" aria-label="Unread"><span {...stylex.props(styles.indicator)} /></span> : undefined}</button>
          <button type="button" {...stylex.props(styles.options)} aria-label={'Options for ' + (session.title || 'conversation')} aria-haspopup="menu" onClick={event => onMenu({ id: session.id, title: session.title, anchor: event.currentTarget, archived: session.archived, projectId: session.projectId, unread: session.unread, status: session.status })}><Ellipsis size={17} strokeWidth={ICON_STROKE} aria-hidden="true" /></button>
        </div>;
      }} />}
      {!rows.length && <p role="status" {...stylex.props(styles.empty)}>{isLoadingNative ? 'Loading conversations…' : nativeError ? 'Could not load conversations.' : chat.isLoadingSessions ? 'Loading conversations…' : chat.authError ? 'Connect in Settings to see your conversations.' : chat.searchQuery ? 'No matching conversations' : view === 'archived' ? 'No archived conversations.' : 'Your conversations will appear here.'}</p>}
    </div>
    {!chat.searchQuery.trim() && (isShowingAll || recentSessions.length > recentLimit || chat.hasMore) && <Button {...stylex.props(styles.showAll)} aria-expanded={isShowingAll} onClick={() => { setShowingAll(current => !current); setView('active'); setProjectId(''); setStatusFilter(''); }}>{isShowingAll ? 'Show recent' : 'Show all'}<ChevronRight size={16} aria-hidden="true" /></Button>}
    <div {...stylex.props(styles.bottom)}><button {...stylex.props(styles.nav)} onClick={onBrowser}><BrowserIcon size={19} />Browser</button><button {...stylex.props(styles.nav)} onClick={onSettings}><Settings2 size={19} strokeWidth={ICON_STROKE} />Settings<span {...stylex.props(styles.connection, chat.isConnected && styles.connected)} role="img" aria-label={chat.isConnected ? 'Connected' : 'Disconnected'} /></button></div>
  </aside>;
}

const recentSessionListComponents = {};

function dateGroup(seconds: number) {
  const date = new Date(seconds * 1000); const today = new Date(); today.setHours(0, 0, 0, 0);
  const difference = today.getTime() - date.getTime();
  if (difference < 0) return 'Today'; if (difference < 86_400_000) return 'Yesterday'; if (difference < 6 * 86_400_000) return 'Previous 7 days';
  return date.toLocaleDateString('en-US', { month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function nativeQueryKey({ view, sort, projectId, status, query }: { view: 'active' | 'archived'; sort: 'newest' | 'oldest'; projectId: string; status: StatusFilter; query: string }) {
  return [view, sort, projectId, status, query.trim()].join('\n');
}

function nativeSessionsUrl({ view, sort, projectId, status, query, cursor, limit }: { view: 'active' | 'archived'; sort: 'newest' | 'oldest'; projectId: string; status: StatusFilter; query: string; cursor: number; limit: number }) {
  const params = new URLSearchParams({ limit: String(limit), cursor: String(cursor), archived: view === 'archived' ? 'only' : 'exclude', parent: 'root', sort });
  if (query.trim()) params.set('q', query.trim());
  if (projectId) params.append('projectId', projectId);
  if (status) params.append('status', status);
  return '/api/native/sessions?' + params;
}

function readNativePage(value: unknown, isArchived: boolean) {
  if (typeof value !== 'object' || value === null) return { items: [], nextCursor: null };
  const list = Reflect.get(value, 'items') ?? Reflect.get(value, 'sessions');
  if (!Array.isArray(list)) return { items: [], nextCursor: null };
  const items = list.flatMap((item): SidebarSession[] => {
    if (typeof item !== 'object' || item === null) return [];
    const id = Reflect.get(item, 'id');
    if (typeof id !== 'string') return [];
    const updatedAt = stringValue(Reflect.get(item, 'updatedAt')) || new Date(0).toISOString();
    const seconds = dateSeconds(Reflect.get(item, 'mtime') ?? updatedAt);
    const status = stringValue(Reflect.get(item, 'status')) || 'idle';
    return [{ id, title: stringValue(Reflect.get(item, 'title')) || 'Untitled conversation', status, unread: Boolean(Reflect.get(item, 'unread')), isPinned: Boolean(Reflect.get(item, 'pinned') ?? Reflect.get(item, 'isPinned')), updatedAt, mtime: seconds, preview: stringValue(Reflect.get(item, 'preview')), lastPrompt: stringValue(Reflect.get(item, 'lastPrompt')), bytes: 0, hasLog: true, archived: isArchived, projectId: stringValue(Reflect.get(item, 'projectId')) || undefined, statusLabel: stringValue(Reflect.get(item, 'statusLabel')) || statusLabel(status), suspensionKind: stringValue(Reflect.get(item, 'suspensionKind')) || undefined }];
  });
  const cursor = Reflect.get(value, 'nextCursor');
  return { items, nextCursor: typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null };
}

function readProjects(value: unknown) {
  if (typeof value !== 'object' || value === null) return [];
  const list = Reflect.get(value, 'items') ?? Reflect.get(value, 'projects');
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): Project[] => {
    if (typeof item !== 'object' || item === null) return [];
    if (Reflect.get(item, 'archivedAt')) return [];
    const id = Reflect.get(item, 'id'); const name = Reflect.get(item, 'name') ?? Reflect.get(item, 'title');
    return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : [];
  });
}

function stringValue(value: unknown) { return typeof value === 'string' ? value : ''; }
function statusLabel(status: string) {
  return ({ running: 'Running', suspended: 'Waiting for you', waiting: 'Waiting for you', interrupted: 'Interrupted', errored: 'Task failed', idle: 'Idle' } as Record<string, string>)[status] ?? status;
}
function dateSeconds(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1_000_000_000_000 ? value / 1000 : value;
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : 0;
}

const styles = stylex.create({
  sidebar: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%', backgroundColor: tokens.surface, paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', minWidth: 0 },
  top: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 68, padding: '8px 16px 8px 24px', flexShrink: 0 },
  brand: { display: 'flex', alignItems: 'center', gap: 8, fontSize: '1.3125rem', fontWeight: 650, letterSpacing: '-.5px' },
  newChatRow: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, margin: '0 14px 12px' },
  newChat: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, flex: 1, padding: '0 14px', borderWidth: 0, borderRadius: 14, backgroundColor: { default: tokens.canvas, ':hover': tokens.hover }, color: tokens.text, fontSize: '0.875rem', fontWeight: 550 },
  search: { display: 'flex', alignItems: 'center', gap: 9, margin: '0 22px 10px', padding: '0 2px', color: tokens.muted, minHeight: 44, flexShrink: 0 },
  searchInput: { borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, width: '100%', minWidth: 0, fontSize: '1rem', padding: '10px 0' },
  clear: { display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 0, color: tokens.muted, backgroundColor: 'transparent', minWidth: 32, minHeight: 44 },
  list: { flex: 1, overflow: 'hidden', minHeight: 0, padding: '0 14px 16px', overscrollBehavior: 'contain' },
  controls: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, padding: '0 14px 10px', flexShrink: 0 },
  segment: { display: 'flex', minWidth: 0, flexBasis: '100%', padding: 2, borderRadius: 12, backgroundColor: tokens.canvas },
  control: { minHeight: 36, flex: 1, minWidth: 0, padding: '0 8px', borderWidth: 0, borderRadius: 10, color: tokens.muted, backgroundColor: 'transparent', fontSize: '0.75rem' },
  activeControl: { color: tokens.text, backgroundColor: tokens.hover },
  projectFilter: { flex: 1, minWidth: 0, height: 36, padding: '0 8px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 10, backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font, fontSize: '0.75rem' },
  group: { minHeight: 50, margin: 0, padding: '20px 12px 7px', fontSize: '0.75rem', color: tokens.muted, fontWeight: 500 },
  session: { display: 'flex', alignItems: 'center', minWidth: 0, borderRadius: 12, marginBottom: 2, backgroundColor: { default: 'transparent', ':hover': tokens.hover } },
  card: { minHeight: 68, marginBottom: 8, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: tokens.canvas },
  selected: { backgroundColor: tokens.hover },
  sessionButton: { display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left', flex: 1, minWidth: 0, minHeight: 48, padding: '10px 4px 10px 12px', borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, fontSize: '0.875rem' },
  cardButton: { minHeight: 68 },
  sessionCopy: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 },
  sessionTitle: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  statusLabel: { fontSize: '0.6875rem', color: tokens.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  options: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 44, flexShrink: 0, borderWidth: 0, backgroundColor: 'transparent', color: tokens.muted },
  pin: { color: tokens.primary, flexShrink: 0 },
  status: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, flexShrink: 0 },
  spinner: { width: '100%', height: '100%', borderRadius: '50%', borderWidth: 2, borderStyle: 'solid', borderColor: tokens.primary, borderTopColor: 'transparent' },
  indicator: { width: 6, height: 6, borderRadius: '50%', backgroundColor: tokens.primary, flexShrink: 0 },
  attention: { width: 8, height: 8, borderRadius: '50%', borderWidth: 2, borderStyle: 'solid', borderColor: tokens.primary, flexShrink: 0 },
  failed: { width: 7, height: 7, borderRadius: '50%', backgroundColor: tokens.danger, flexShrink: 0 },
  bottom: { borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: tokens.border, padding: '10px 14px', flexShrink: 0 },
  nav: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, width: '100%', borderWidth: 0, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text, padding: '0 12px', borderRadius: 12, fontSize: '0.875rem', textAlign: 'left' },
  connection: { width: 6, height: 6, borderRadius: '50%', backgroundColor: tokens.muted, marginLeft: 'auto' },
  connected: { backgroundColor: tokens.primary },
  empty: { fontSize: '0.875rem', lineHeight: 1.6, color: tokens.muted, padding: 12 },
  more: { marginTop: 12, width: '100%', backgroundColor: 'transparent' },
  showAll: { margin: '0 14px 12px', flexShrink: 0 },
});
