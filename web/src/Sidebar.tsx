import { parseProjects } from './responses';
import { APP_NAME } from './brand';
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { motion, useReducedMotion } from 'motion/react';
import { Virtuoso } from 'react-virtuoso';
import { Archive, ArrowDownUp, ChevronLeft, ChevronRight, Ellipsis, EyeOff, Grid2X2, List, Pin, PinOff, Plus, Search, Settings2, SquarePen, Trash2, X } from 'lucide-react';
import type { ChatSession, SessionSettings, UseChat } from './types';
import type { SessionMenuTarget } from './SessionMenu';
import { tokens } from './tokens.stylex';
import { DEFAULT_RECENT_CHAT_LIMIT, ICON_STROKE, SESSION_CHANGE_EVENT, BrowserIcon, IconButton, styles as ui } from './ui';
import { Button } from './Button';
import { useAutoRefresh } from './useAutoRefresh';
import { TabBar, TabContext, useIsPhone } from './TabBar';

const NATIVE_PAGE_SIZE = 50;
const NATIVE_REFRESH_INTERVAL_MS = 5_000;
type Project = { id: string; name: string };
type StatusFilter = '' | 'running' | 'suspended' | 'idle' | 'interrupted' | 'errored';
type SidebarSession = ChatSession & { archived?: boolean; projectId?: string; statusLabel?: string; suspensionKind?: string };
type SidebarRow = { kind: 'heading'; group: string } | { kind: 'session'; session: SidebarSession } | { kind: 'pins'; sessions: SidebarSession[] } | { kind: 'more' };
const SWIPE_ACTION_WIDTH = 74;

export function Sidebar({ chat, isDrawer, onClose, onNew, onNewIncognito, onOpen, onSettings, onBrowser, onMenu, onDelete }: {
  chat: UseChat; isDrawer?: boolean; onClose?: () => void; onNew: () => void; onNewIncognito?: () => void; onOpen: (id: string) => void; onSettings: () => void; onBrowser: () => void; onMenu: (target: SessionMenuTarget) => void; onDelete?: (session: { id: string; title: string }) => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  const tabs = useContext(TabContext);
  const isPhone = useIsPhone();
  const isPage = !!isDrawer && !!tabs && isPhone;
  const [swipedId, setSwipedId] = useState<string>();
  const [isShowingAll, setShowingAll] = useState(false);
  const [recentLimit, setRecentLimit] = useState(DEFAULT_RECENT_CHAT_LIMIT);
  useEffect(() => {
    if (!chat.isReady || chat.authError) return;
    const controller = new AbortController();
    let generation = 0;
    async function refreshPreference() {
      const currentGeneration = ++generation;
      try {
        const response = await chat.request('/api/native/workspace/preferences', { signal: controller.signal });
        const value: unknown = await response.json();
        const preference = typeof value === 'object' && value !== null ? Reflect.get(value, 'sidebarRecentChatLimit') : undefined;
        const limit = typeof preference === 'string' ? Number(preference) : preference;
        if (currentGeneration === generation && typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50) setRecentLimit(limit);
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
    void chat.request('/api/native/projects', { cache: 'no-store', signal: controller.signal }).then(response => response.json()).then(value => { if (!controller.signal.aborted) setProjects(parseProjects(value).filter(project => !project.archivedAt)); }).catch(() => undefined);
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
  const showsPinCards = isPage && view === 'active' && !chat.searchQuery.trim() && layout === 'list';
  const pinCards = showsPinCards ? visibleSessions.filter(session => session.isPinned) : [];
  const rows: SidebarRow[] = [...(pinCards.length ? [{ kind: 'pins' as const, sessions: pinCards }] : []), ...visibleSessions.filter(session => !pinCards.includes(session)).flatMap(session => {
    const group = view === 'active' && session.isPinned ? 'Pinned' : dateGroup(session.mtime); const hasHeading = group !== lastGroup; lastGroup = group;
    return [...(hasHeading ? [{ kind: 'heading' as const, group }] : []), { kind: 'session' as const, session }];
  })];
  async function setPinned(session: SidebarSession) {
    setSwipedId(undefined);
    if (await chat.updateSession(session.id, { isPinned: !session.isPinned }, { isPinned: !!session.isPinned })) window.dispatchEvent(new Event(SESSION_CHANGE_EVENT));
  }
  async function archive(session: SidebarSession) {
    setSwipedId(undefined);
    if (await chat.updateSession(session.id, { archived: true }, { archived: false, unread: !!session.unread })) window.dispatchEvent(new Event(SESSION_CHANGE_EVENT));
  }
  if (isExpanded && (nextCursor != null || isLoadingMoreNative)) rows.push({ kind: 'more' });
  return <aside {...stylex.props(styles.sidebar, isPage && styles.page)} aria-label="Conversations" onPointerDown={event => {
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
    {isPage ? <>
      <div {...stylex.props(styles.pageBar)}><IconButton label="Close conversations" onClick={onClose}><ChevronLeft size={24} strokeWidth={ICON_STROKE} /></IconButton><span {...stylex.props(styles.pageActions)}>{onNewIncognito && <IconButton label="New incognito chat" onClick={onNewIncognito}><EyeOff size={20} strokeWidth={ICON_STROKE} /></IconButton>}<IconButton label="New chat" onClick={onNew}><SquarePen size={21} strokeWidth={ICON_STROKE} /></IconButton></span></div>
      <h1 {...stylex.props(styles.largeTitle)}>Chats</h1>
    </> : <>
      <div {...stylex.props(styles.top)}><span {...stylex.props(styles.brand)}><img src="/icons/mark.svg" width={24} height={24} alt="" aria-hidden="true" />{APP_NAME}</span>{isDrawer && <IconButton label="Close conversations" onClick={onClose}><X size={22} strokeWidth={ICON_STROKE} /></IconButton>}</div>
      <div {...stylex.props(styles.newChatRow)}><button {...stylex.props(styles.newChat)} onClick={onNew}><Plus size={20} strokeWidth={ICON_STROKE} />New chat</button>{onNewIncognito && <IconButton label="New incognito chat" onClick={onNewIncognito}><EyeOff size={19} strokeWidth={ICON_STROKE} /></IconButton>}</div>
    </>}
    <div {...stylex.props(styles.search, isPage && styles.pageSearch)}><Search size={17} strokeWidth={ICON_STROKE} /><input aria-label="Search conversations" placeholder="Search" value={chat.searchQuery} onChange={event => chat.setSearchQuery(event.target.value)} {...stylex.props(styles.searchInput)} />{chat.searchQuery && <button {...stylex.props(styles.clear)} aria-label="Clear search" onClick={() => chat.setSearchQuery('')}><X size={16} /></button>}</div>
    {isShowingAll && <div {...stylex.props(styles.controls)}>
      <div {...stylex.props(styles.segment)}><button type="button" aria-pressed={view === 'active'} {...stylex.props(styles.control, view === 'active' && styles.activeControl)} onClick={() => setView('active')}>Chats</button><button type="button" aria-pressed={view === 'archived'} {...stylex.props(styles.control, view === 'archived' && styles.activeControl)} onClick={() => setView('archived')}><span>Archive</span></button></div>
      <select aria-label="Filter by project" value={projectId} {...stylex.props(styles.projectFilter)} onChange={event => setProjectId(event.target.value)}><option value="">All projects</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <select aria-label="Filter by status" value={statusFilter} {...stylex.props(styles.projectFilter)} onChange={event => setStatusFilter(event.target.value as StatusFilter)}><option value="">All statuses</option><option value="running">Running</option><option value="suspended">Needs attention</option><option value="idle">Completed</option><option value="interrupted">Interrupted</option><option value="errored">Failed</option></select>
      <IconButton label={sort === 'newest' ? 'Newest first' : 'Oldest first'} onClick={() => setSort(current => current === 'newest' ? 'oldest' : 'newest')}><ArrowDownUp size={17} strokeWidth={ICON_STROKE} /></IconButton>
      <IconButton label={layout === 'list' ? 'Card view' : 'List view'} onClick={() => setLayout(current => current === 'list' ? 'card' : 'list')}>{layout === 'list' ? <Grid2X2 size={17} strokeWidth={ICON_STROKE} /> : <List size={17} strokeWidth={ICON_STROKE} />}</IconButton>
    </div>}
    <div {...stylex.props(styles.list, isPage && styles.pageList)}>
      {rows.length > 0 && <Virtuoso data={rows} initialItemCount={12} defaultItemHeight={layout === 'card' ? 76 : 50} increaseViewportBy={150} style={{ height: '100%' }} computeItemKey={(_, row) => row.kind === 'heading' ? row.group : row.kind === 'more' ? 'load-more' : row.kind === 'pins' ? 'pinned-cards' : row.session.id} components={recentSessionListComponents} itemContent={(_, row) => {
        if (row.kind === 'heading') return <h2 {...stylex.props(styles.group)}>{row.group}</h2>;
        if (row.kind === 'pins') return <div {...stylex.props(styles.pins)}>{row.sessions.map(session => <div key={session.id} {...stylex.props(styles.pinWrap)}><button type="button" data-session-id={session.id} aria-current={session.id === chat.sessionId ? 'page' : undefined} {...stylex.props(styles.pinCard)} onClick={() => onOpen(session.id)}><span {...stylex.props(styles.pinTitle)}>{session.title || 'Untitled conversation'}</span><span {...stylex.props(styles.pinMeta)}><Pin size={12} strokeWidth={ICON_STROKE} aria-label="Pinned" />Pinned</span></button><button type="button" {...stylex.props(styles.pinOptions)} aria-label={'Options for ' + (session.title || 'conversation')} aria-haspopup="menu" onClick={event => onMenu({ id: session.id, title: session.title, anchor: event.currentTarget, archived: session.archived, projectId: session.projectId, unread: session.unread, status: session.status })}><Ellipsis size={17} strokeWidth={ICON_STROKE} aria-hidden="true" /></button></div>)}</div>;
        if (row.kind === 'more') return <Button {...stylex.props(styles.more)} disabled={isLoadingMoreNative} onClick={() => { void loadMoreNative(); }}>{isLoadingMoreNative ? 'Loading…' : 'Show more'}<ChevronRight size={16} /></Button>;
        const session = row.session;
        const isRunning = session.status === 'running' || session.id === chat.sessionId && chat.isRunning;
        const needsAttention = !!session.suspensionKind || session.status === 'suspended' || session.status === 'waiting';
        const isRunningNow = isRunning;
        const rowContent = <div {...stylex.props(styles.session, isPage && styles.pageSession, layout === 'card' && styles.card, session.id === chat.sessionId && styles.selected)}>
          <button data-session-id={session.id} {...stylex.props(styles.sessionButton, isPage && styles.pageSessionButton, layout === 'card' && styles.cardButton)} title={session.statusLabel ? `${session.title || 'Untitled conversation'} · ${session.statusLabel}` : session.title || 'Untitled conversation'} aria-current={session.id === chat.sessionId ? 'page' : undefined} onClick={() => onOpen(session.id)}><span {...stylex.props(styles.sessionCopy)}><span {...stylex.props(styles.sessionTitle)}>{session.title || 'Untitled conversation'}</span>{layout === 'card' && session.statusLabel && <span {...stylex.props(styles.statusLabel)}>{session.statusLabel}</span>}</span>{session.isPinned && <Pin {...stylex.props(styles.pin)} size={13} strokeWidth={ICON_STROKE} aria-label="Pinned" />}{isRunning ? <span {...stylex.props(styles.status)} role="img" aria-label="Running"><motion.span {...stylex.props(styles.spinner)} aria-hidden="true" animate={shouldReduceMotion ? undefined : { rotate: 360 }} transition={{ duration: .8, repeat: Infinity, ease: 'linear' }} /></span> : needsAttention ? <span {...stylex.props(styles.status)} role="img" aria-label={session.statusLabel || 'Needs attention'}><span {...stylex.props(styles.attention)} /></span> : session.status === 'errored' ? <span {...stylex.props(styles.status)} role="img" aria-label={session.statusLabel || 'Task failed'}><span {...stylex.props(styles.failed)} /></span> : session.unread && session.id !== chat.sessionId ? <span {...stylex.props(styles.status)} role="img" aria-label="Unread"><span {...stylex.props(styles.indicator)} /></span> : undefined}</button>
          <button type="button" {...stylex.props(styles.options)} aria-label={'Options for ' + (session.title || 'conversation')} aria-haspopup="menu" onClick={event => onMenu({ id: session.id, title: session.title, anchor: event.currentTarget, archived: session.archived, projectId: session.projectId, unread: session.unread, status: session.status })}><Ellipsis size={17} strokeWidth={ICON_STROKE} aria-hidden="true" /></button>
        </div>;
        if (!isPage) return rowContent;
        return <SwipeRow isOpen={swipedId === session.id} onOpenChange={isOpen => setSwipedId(isOpen ? session.id : undefined)} actions={[
          { label: session.isPinned ? 'Unpin' : 'Pin', color: '#f29d38', icon: session.isPinned ? <PinOff size={18} strokeWidth={ICON_STROKE} /> : <Pin size={18} strokeWidth={ICON_STROKE} />, onSelect: () => { void setPinned(session); } },
          { label: 'Archive', color: '#6b6b70', icon: <Archive size={18} strokeWidth={ICON_STROKE} />, onSelect: () => { void archive(session); } },
          ...(onDelete && !isRunningNow ? [{ label: 'Delete', color: 'var(--danger)', icon: <Trash2 size={18} strokeWidth={ICON_STROKE} />, onSelect: () => { setSwipedId(undefined); onDelete({ id: session.id, title: session.title || 'Untitled conversation' }); } }] : []),
        ]}>{rowContent}</SwipeRow>;
      }} />}
      {!rows.length && <p role="status" {...stylex.props(styles.empty)}>{isLoadingNative ? 'Loading conversations…' : nativeError ? 'Could not load conversations.' : chat.isLoadingSessions ? 'Loading conversations…' : chat.authError ? 'Connect in Settings to see your conversations.' : chat.searchQuery ? 'No matching conversations' : view === 'archived' ? 'No archived conversations.' : 'Your conversations will appear here.'}</p>}
    </div>
    {!chat.searchQuery.trim() && (isShowingAll || recentSessions.length > recentLimit || chat.hasMore) && <Button {...stylex.props(styles.showAll)} aria-expanded={isShowingAll} onClick={() => { setShowingAll(current => !current); setView('active'); setProjectId(''); setStatusFilter(''); }}>{isShowingAll ? 'Show recent' : 'Show all'}<ChevronRight size={16} aria-hidden="true" /></Button>}
    {isPage ? <TabBar /> : <div {...stylex.props(styles.bottom)}><button {...stylex.props(styles.nav)} onClick={onBrowser}><BrowserIcon size={19} />Browser</button><button {...stylex.props(styles.nav)} onClick={onSettings}><Settings2 size={19} strokeWidth={ICON_STROKE} />Settings<span {...stylex.props(styles.connection, chat.isConnected && styles.connected)} role="img" aria-label={chat.isConnected ? 'Connected' : 'Disconnected'} /></button></div>}
  </aside>;
}

const recentSessionListComponents = {};

/** A list row that slides left under a finger to reveal its actions, like iOS Mail. Only one row stays open at a time. */
function SwipeRow({ children, actions, isOpen, onOpenChange }: { children: ReactNode; actions: { label: string; color: string; icon: ReactNode; onSelect: () => void }[]; isOpen: boolean; onOpenChange: (isOpen: boolean) => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; base: number; offset: number; isDragging: boolean } | undefined>(undefined);
  const width = actions.length * SWIPE_ACTION_WIDTH;
  const resting = isOpen ? -width : 0;
  function move(x: number, y: number) {
    const current = gesture.current; const content = contentRef.current;
    if (!current || !content) return;
    const dx = x - current.x; const dy = y - current.y;
    if (!current.isDragging) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { gesture.current = undefined; return; }
      if (Math.abs(dx) < 10) return;
      current.isDragging = true;
    }
    current.offset = Math.min(0, Math.max(-width, current.base + dx));
    content.style.transition = 'none';
    content.style.transform = `translateX(${current.offset}px)`;
  }
  function finish() {
    const current = gesture.current; const content = contentRef.current;
    gesture.current = undefined;
    if (!current?.isDragging || !content) return;
    content.style.removeProperty('transition');
    content.style.removeProperty('transform');
    onOpenChange(current.offset < -width / 2);
  }
  return <div data-swipe-row="" {...stylex.props(styles.swipeRow)}
    onTouchStart={event => { const touch = event.touches[0]; if (event.touches.length === 1 && touch) gesture.current = { x: touch.clientX, y: touch.clientY, base: resting, offset: resting, isDragging: false }; }}
    onTouchMove={event => { const touch = event.touches[0]; if (touch) move(touch.clientX, touch.clientY); }}
    onTouchEnd={finish} onTouchCancel={finish}>
    <div {...stylex.props(styles.swipeActions)} style={{ width }} aria-hidden={!isOpen}>{actions.map(action => <button key={action.label} type="button" tabIndex={isOpen ? 0 : -1} {...stylex.props(styles.swipeAction)} style={{ backgroundColor: action.color }} onClick={action.onSelect}>{action.icon}<span>{action.label}</span></button>)}</div>
    <div ref={contentRef} {...stylex.props(styles.swipeContent)} style={{ transform: `translateX(${resting}px)` }} onClickCapture={event => { if (isOpen) { event.preventDefault(); event.stopPropagation(); onOpenChange(false); } }}>{children}</div>
  </div>;
}

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
  pins: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, padding: '4px 8px 14px' },
  pinWrap: { position: 'relative', minWidth: 0 },
  pinOptions: { position: 'absolute', top: 0, right: 0, width: 44, height: 44, display: 'grid', placeItems: 'center', borderWidth: 0, backgroundColor: 'transparent', color: tokens.muted },
  pinCard: { width: '100%', paddingRight: 40, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8, minHeight: 76, padding: '12px 14px', borderWidth: 0, borderRadius: 18, backgroundColor: { default: tokens.surface, ':hover': tokens.hover }, color: tokens.text, textAlign: 'left', fontFamily: tokens.font },
  pinTitle: { fontSize: '.9375rem', fontWeight: 650, lineHeight: 1.3, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' },
  pinMeta: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.75rem', color: tokens.muted },
  swipeRow: { position: 'relative', overflow: 'hidden', borderRadius: 14, marginBottom: 2 },
  swipeActions: { position: 'absolute', top: 1, right: 1, bottom: 1, display: 'flex', borderRadius: 13, overflow: 'hidden' },
  swipeAction: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, borderWidth: 0, color: '#ffffff', fontFamily: tokens.font, fontSize: '.75rem', fontWeight: 600 },
  swipeContent: { position: 'relative', backgroundColor: tokens.canvas, transitionProperty: 'transform', transitionDuration: '.22s', transitionTimingFunction: 'cubic-bezier(.22,1,.36,1)' },
  page: { backgroundColor: tokens.canvas, paddingBottom: 'calc(88px + env(safe-area-inset-bottom))' },
  pageBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 52, padding: '4px max(6px, env(safe-area-inset-right)) 0 max(6px, env(safe-area-inset-left))', flexShrink: 0 },
  pageActions: { display: 'flex', alignItems: 'center' },
  largeTitle: { margin: 0, padding: '0 20px 10px', fontSize: '2.125rem', fontWeight: 700, letterSpacing: '-.6px', lineHeight: 1.15, flexShrink: 0 },
  pageSearch: { margin: '0 16px 10px', padding: '0 12px', borderRadius: 12, backgroundColor: tokens.bubble },
  pageList: { padding: '0 8px 0' },
  pageSession: { borderRadius: 14, marginBottom: 0 },
  pageSessionButton: { minHeight: 52, fontSize: '1rem', padding: '12px 4px 12px 12px' },
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
