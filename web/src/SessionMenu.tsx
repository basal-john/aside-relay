import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Archive, ArchiveRestore, Check, Copy, Files, FolderInput, Link, Mail, MailOpen, Pencil, Pin, PinOff, Share2, Trash2 } from 'lucide-react';
import type { UseChat } from './types';
import { parseSessionDetails } from './responses';
import { PopoverMenu } from './PopoverMenu';
import { tokens } from './tokens.stylex';
import { ICON_STROKE, RENAME_CONVERSATION_TITLE, styles as ui } from './ui';
import { Button } from './Button';
import { Dialog, DialogActions, DialogDescription } from './Dialog';

export type SessionMenuTarget = { id: string; title: string; anchor: HTMLElement; point?: { x: number; y: number }; archived?: boolean; projectId?: string; unread?: boolean; status?: string };
type Conversation = { id: string; title: string };
type Project = { id: string; name: string };

export function SessionMenu({ target, chat, onClose, onRename, onDelete, onFiles, notify }: {
  target: SessionMenuTarget; chat: UseChat; onClose: () => void; onRename: (session: Conversation) => void; onDelete: (session: Conversation) => void;
  onFiles?: (sessionId: string) => void;
  notify: (text: string, kind?: 'error' | 'success') => void;
}) {
  const [details, setDetails] = useState<ReturnType<typeof parseSessionDetails>>();
  const [dialog, setDialog] = useState<'project'>();
  const [isBusy, setBusy] = useState(false);
  const session = chat.sessions.find(session => session.id === target.id);
  const url = new URL('/c/' + encodeURIComponent(target.id), location.origin).href;
  const title = session?.title ?? details?.title ?? target.title;
  const isPinned = session?.isPinned ?? details?.isPinned ?? false;
  const isUnread = session?.unread ?? target.unread ?? false;
  useEffect(() => {
    if (session) return;
    const controller = new AbortController();
    void chat.request('/api/sessions/' + encodeURIComponent(target.id) + '/details', { signal: controller.signal })
      .then(response => response.json()).then(value => { if (!controller.signal.aborted) setDetails(parseSessionDetails(value)); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [target.id, chat.request, session?.id]);

  async function copy(text: string, message: string) {
    onClose();
    try { await navigator.clipboard.writeText(text); notify(message, 'success'); }
    catch { notify('Could not copy. Try again.', 'error'); }
  }
  async function mutateNative(path: string, successMessage: string) {
    setBusy(true); onClose();
    if (path === '/archive' && chat.sessionId === target.id) chat.newChat();
    try {
      const response = await chat.request('/api/native/sessions/' + encodeURIComponent(target.id) + path, { method: 'POST' });
      if (!response.ok) throw new Error();
      window.dispatchEvent(new Event('aside:sessions-changed'));
      await chat.refreshSessions();
      notify(successMessage, 'success');
      return response;
    } catch {
      setBusy(false);
      notify('Could not update the conversation. Try again.', 'error');
    }
  }

  async function shareSnapshot() {
    setBusy(true); onClose();
    try {
      const response = await chat.request('/api/native/sessions/' + encodeURIComponent(target.id) + '/share', { method: 'POST' });
      if (!response.ok) throw new Error();
      const result = await response.json() as unknown;
      const snapshotUrl = readSnapshotUrl(result);
      if (!snapshotUrl) throw new Error();
      if (navigator.share) await navigator.share({ title, text: title, url: snapshotUrl });
      else { await navigator.clipboard.writeText(snapshotUrl); notify('Snapshot link copied.', 'success'); }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setBusy(false);
      notify('Could not share the snapshot. Try again.', 'error');
    }
  }

  async function updatePinned() {
    onClose();
    if (await chat.updateSession(target.id, { isPinned: !isPinned })) window.dispatchEvent(new Event('aside:sessions-changed'));
  }

  if (dialog === 'project') return <MoveConversationDialog sessionId={target.id} currentProjectId={target.projectId} chat={chat} notify={notify} onClose={onClose} />;

  return <PopoverMenu anchor={target.anchor} point={target.point} label="Conversation options" onClose={onClose}>
    <p {...stylex.props(styles.title)}>{title}</p>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} onClick={() => { void updatePinned(); }}>{isPinned ? <PinOff {...stylex.props(styles.pin)} size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Pin {...stylex.props(styles.pin)} size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />}<span>{isPinned ? 'Unpin conversation' : 'Pin conversation'}</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} onClick={() => { onClose(); onRename({ id: target.id, title }); }}><Pencil size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Rename</span></button>
    {onFiles && <button type="button" role="menuitem" {...stylex.props(styles.action)} onClick={() => { onClose(); onFiles(target.id); }}><Files size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Files &amp; outputs</span></button>}
    <button type="button" role="menuitem" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => { setDialog('project'); }}><FolderInput size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Move to project</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => { void mutateNative(isUnread ? '/read' : '/unread', isUnread ? 'Marked as read.' : 'Marked as unread.'); }}>{isUnread ? <MailOpen size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Mail size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />}<span>{isUnread ? 'Mark as read' : 'Mark as unread'}</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => { void mutateNative(target.archived ? '/unarchive' : '/archive', target.archived ? 'Conversation restored.' : 'Conversation archived.'); }}>{target.archived ? <ArchiveRestore size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Archive size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />}<span>{target.archived ? 'Unarchive' : 'Archive'}</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => void shareSnapshot()}><Share2 size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Share snapshot</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} onClick={() => void copy(url, 'Session link copied.')}><Link size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Copy link</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} onClick={() => void copy(target.id, 'Session ID copied.')}><Copy size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Copy session ID</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action, ui.danger)} disabled={(session?.status ?? target.status ?? details?.status) === 'running' || (target.id === chat.sessionId && chat.isRunning)} onClick={() => { onClose(); onDelete({ id: target.id, title }); }}><Trash2 size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Delete conversation</span></button>
  </PopoverMenu>;
}

function MoveConversationDialog({ sessionId, currentProjectId, chat, notify, onClose }: { sessionId: string; currentProjectId?: string; chat: UseChat; notify: (text: string, kind?: 'error' | 'success') => void; onClose: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState(currentProjectId ?? '');
  const [isLoading, setLoading] = useState(true);
  const [isSaving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void chat.request('/api/native/projects', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const result = await response.json() as unknown;
      if (!controller.signal.aborted) setProjects(readProjects(result));
    }).catch(() => { if (!controller.signal.aborted) notify('Could not load projects.', 'error'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [chat.request, notify]);
  return <Dialog title="Move to project" onClose={onClose}>
    <DialogDescription>Choose where this conversation belongs.</DialogDescription>
    <div role="radiogroup" aria-label="Projects" {...stylex.props(styles.projects)}>
      {!isLoading && <button type="button" role="radio" aria-checked={!selectedId} {...stylex.props(styles.project, !selectedId && styles.selectedProject)} onClick={() => setSelectedId('')}><span>No project</span>{!selectedId && <Check size={18} strokeWidth={ICON_STROKE} />}</button>}
      {projects.map(project => <button key={project.id} type="button" role="radio" aria-checked={selectedId === project.id} {...stylex.props(styles.project, selectedId === project.id && styles.selectedProject)} onClick={() => setSelectedId(project.id)}><span>{project.name}</span>{selectedId === project.id && <Check size={18} strokeWidth={ICON_STROKE} />}</button>)}
      {isLoading && <p role="status" {...stylex.props(ui.muted)}>Loading projects…</p>}
      {!isLoading && !projects.length && <p {...stylex.props(ui.muted)}>No projects yet.</p>}
    </div>
    <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={isLoading || isSaving} onClick={async () => {
      setSaving(true);
      try {
        const response = await chat.request('/api/native/sessions/' + encodeURIComponent(sessionId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: selectedId || null }) });
        if (!response.ok) throw new Error();
        window.dispatchEvent(new Event('aside:sessions-changed'));
        onClose(); await chat.refreshSessions(); notify('Conversation moved.', 'success');
      } catch { setSaving(false); notify('Could not move the conversation.', 'error'); }
    }}>Move</Button></DialogActions>
  </Dialog>;
}

function readProjects(value: unknown) {
  if (typeof value !== 'object' || value === null) return [];
  const list = Reflect.get(value, 'items') ?? Reflect.get(value, 'projects') ?? value;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): Project[] => {
    if (typeof item !== 'object' || item === null) return [];
    const id = Reflect.get(item, 'id'); const name = Reflect.get(item, 'name') ?? Reflect.get(item, 'title');
    return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : [];
  });
}

function readSnapshotUrl(value: unknown) {
  if (typeof value !== 'object' || value === null) return;
  const result = Reflect.get(value, 'result');
  const candidates = [Reflect.get(value, 'url'), Reflect.get(value, 'shareUrl'), typeof result === 'object' && result !== null ? Reflect.get(result, 'url') : undefined];
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && /^https?:\/\//.test(candidate));
}

export function RenameConversation({ session, chat, onClose }: { session: Conversation; chat: UseChat; onClose: () => void }) {
  const [title, setTitle] = useState(session.title);
  const input = useRef<HTMLInputElement>(null);
  return <Dialog title={RENAME_CONVERSATION_TITLE} initialFocus={input} onClose={onClose}><form onSubmit={event => {
    event.preventDefault(); if (!title.trim()) return;
    const nextTitle = title.trim(); onClose();
    void chat.updateSession(session.id, { title: nextTitle }).then(isUpdated => { if (isUpdated) window.dispatchEvent(new Event('aside:sessions-changed')); });
  }}>
    <DialogDescription>Choose a name for this conversation.</DialogDescription>
    <input ref={input} aria-label="Conversation name" maxLength={120} value={title} {...stylex.props(ui.field)} onChange={event => setTitle(event.target.value)} />
    <DialogActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={!title.trim()}>Save</Button></DialogActions>
  </form></Dialog>;
}

const styles = stylex.create({
  pin: { color: tokens.primary },
  title: { margin: '4px 12px 8px', fontSize: '0.8125rem', lineHeight: 1.4, color: tokens.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  action: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, width: '100%', padding: '10px 12px', borderWidth: 0, borderRadius: 14, textAlign: 'left', color: tokens.text, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, fontSize: '0.875rem', lineHeight: 1.4 },
  projects: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 'min(360px, 50dvh)', overflowY: 'auto' },
  project: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%', minHeight: 48, padding: '10px 14px', borderWidth: 0, borderRadius: 14, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text, textAlign: 'left' },
  selectedProject: { color: tokens.primary, backgroundColor: tokens.hover },
});
