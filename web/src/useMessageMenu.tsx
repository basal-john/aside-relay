import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import * as stylex from '@stylexjs/stylex';
import { CornerUpRight, Copy, GitBranch, MessageCircleQuestion, MessageSquarePlus, Pencil, TextSelect } from 'lucide-react';
import type { UseChat } from './types';
import { tokens } from './tokens.stylex';
import { ICON_STROKE, styles as ui } from './ui';
import { Dialog, DialogActions, DialogDescription } from './Dialog';
import { Button } from './Button';

const MENU_MARGIN = 8;
const LONG_PRESS_MS = 500;
const MOVEMENT_LIMIT = 8;
const INTERACTIVE = 'a, button, input, textarea, select, iframe, pre, code, summary';
type SelectedMessage = { id: string; nativeId?: string; seq?: number; role: 'user' | 'assistant'; text: string; article: HTMLElement; turn?: number };
export type MessageMenuOptions = {
  textForMessage: (id: string) => string;
  notify: (text: string, kind?: 'success' | 'error') => void;
  sessionId?: string;
  request?: UseChat['request'];
  onOpenSession?: (sessionId: string) => void;
  onRefreshMessages?: () => void | Promise<void>;
  onComposeContext?: (context: { messageId: string; text: string }) => void;
  onAskSidechat?: (context: { messageId: string; text: string }) => void;
  onNavigateTurns?: () => void;
};

export function useMessageMenu({ textForMessage, notify, ...options }: MessageMenuOptions) {
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<SelectedMessage | undefined>(undefined);
  const pressRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const [selectableId, setSelectableId] = useState<string>();
  const [selectedMessage, setSelectedMessage] = useState<SelectedMessage>();
  const [editTarget, setEditTarget] = useState<SelectedMessage>();
  const [editText, setEditText] = useState('');
  const [isSaving, setSaving] = useState(false);

  function cancelPress() {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    pressRef.current = undefined;
  }

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      if (event.type === 'pointerdown' && event.target instanceof Node && !selectedRef.current?.article.contains(event.target)) setSelectableId(undefined);
      cancelPress(); menuRef.current?.hidePopover();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    window.visualViewport?.addEventListener('resize', close);
    return () => {
      cancelPress(); window.removeEventListener('pointerdown', close, true); window.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
      window.visualViewport?.removeEventListener('resize', close);
    };
  }, []);

  function messageAt(target: EventTarget) {
    if (!(target instanceof Element) || target.closest(INTERACTIVE)) return;
    const article = target.closest<HTMLElement>('article[data-message-id]');
    if (!article || article.dataset.messageId === selectableId) return;
    return messageFrom(article);
  }

  function messageFrom(article: HTMLElement) {
    const id = article.dataset.messageId ?? '';
    const text = textForMessage(id);
    const role: SelectedMessage['role'] = article.dataset.messageRole === 'user' || article.getAttribute('aria-label') === 'Your message' ? 'user' : 'assistant';
    const turn = Number(article.dataset.turnIndex);
    const seq = Number(id);
    if (text) return { article, text, id, nativeId: article.dataset.nativeMessageId || undefined, seq: Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined, role, turn: Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined };
  }

  function openMenu(message: SelectedMessage, x: number, y: number) {
    cancelPress();
    const menu = menuRef.current;
    if (!menu) return;
    selectedRef.current = message;
    setSelectedMessage(message);
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + MENU_MARGIN;
    const top = (viewport?.offsetTop ?? 0) + MENU_MARGIN;
    const right = left + (viewport?.width ?? document.documentElement.clientWidth) - MENU_MARGIN * 2;
    const bottom = top + (viewport?.height ?? innerHeight) - MENU_MARGIN * 2;
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    menu.style.maxHeight = Math.max(0, bottom - top) + 'px';
    menu.showPopover();
    const box = menu.getBoundingClientRect();
    menu.style.left = Math.max(left, Math.min(x - box.width / 2, right - box.width)) + 'px';
    menu.style.top = Math.max(top, Math.min(y - box.height - MENU_MARGIN < top ? y + MENU_MARGIN : y - box.height - MENU_MARGIN, bottom - box.height)) + 'px';
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  const handlers = {
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      cancelPress();
      if (event.button !== 0 || !event.isPrimary) return;
      const message = messageAt(event.target);
      if (!message) return;
      setSelectableId(undefined);
      const { clientX: x, clientY: y } = event;
      pressRef.current = { x, y, timer: setTimeout(() => openMenu(message, x, y), LONG_PRESS_MS) };
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const press = pressRef.current;
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVEMENT_LIMIT) cancelPress();
    },
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
      cancelPress();
      const article = event.target instanceof Element ? event.target.closest<HTMLElement>('article[data-message-id]') : undefined;
      if (!article || article.dataset.messageId !== selectableId) return;
      requestAnimationFrame(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount || !article.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
        const message = messageFrom(article); const box = selection.getRangeAt(0).getBoundingClientRect();
        if (message) openMenu(message, box.left + box.width / 2, box.top);
      });
    },
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    onContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
      const message = messageAt(event.target);
      if (!message) return;
      event.preventDefault(); openMenu(message, event.clientX, event.clientY);
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      const message = messageAt(event.target);
      if (!message) return;
      event.preventDefault();
      const box = message.article.getBoundingClientRect();
      openMenu(message, box.left + box.width / 2, box.top);
    },
  };

  const menu = <div ref={menuRef} popover="manual" role="menu" aria-label="Message options" className={[stylex.props(styles.menu).className, 'message-menu'].join(' ')} onKeyDown={event => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const current = buttons.findIndex(button => button === document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus(); }
    if (event.key === 'Tab') { event.currentTarget.hidePopover(); selectedRef.current?.article.focus({ preventScroll: true }); }
    if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.hidePopover(); selectedRef.current?.article.focus({ preventScroll: true }); }
  }}>
    <button type="button" role="menuitem" {...stylex.props(styles.item)} onClick={async () => {
      const selected = selectedRef.current;
      if (!selected) return;
      menuRef.current?.hidePopover();
      selected.article.focus({ preventScroll: true });
      try { await navigator.clipboard.writeText(selected.text); notify('Copied to clipboard', 'success'); }
      catch { notify('Could not copy. Select the text to copy it.', 'error'); }
    }}><Copy size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Copy</button>
    {selectedMessage?.role === 'user' && (selectedMessage.nativeId || selectedMessage.seq !== undefined) && options.request && options.sessionId && <button type="button" role="menuitem" {...stylex.props(styles.item)} onClick={() => {
      const selected = selectedRef.current;
      if (!selected) return;
      menuRef.current?.hidePopover(); setEditText(selected.text); setEditTarget(selected);
    }}><Pencil size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Edit message</button>}
    {selectedMessage?.role === 'assistant' && (selectedMessage.nativeId || selectedMessage.seq !== undefined) && options.request && options.sessionId && <button type="button" role="menuitem" {...stylex.props(styles.item)} onClick={() => { void branchMessage(); }}><GitBranch size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Branch conversation</button>}
    {selectedMessage?.role === 'assistant' && <button type="button" role="menuitem" {...stylex.props(styles.item)} onClick={() => {
      const selected = selectedRef.current; if (!selected) return;
      const text = selectedText(selected); menuRef.current?.hidePopover();
      const messageId = selected.nativeId ?? selected.id;
      if (options.onComposeContext) options.onComposeContext({ messageId, text });
      else window.dispatchEvent(new CustomEvent('aside:add-comment', { detail: { sessionId: options.sessionId, messageId, text } }));
    }}><MessageSquarePlus size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Add to chat</button>}
    {selectedMessage?.role === 'assistant' && <button type="button" role="menuitem" {...stylex.props(styles.item)} onClick={() => {
      const selected = selectedRef.current; if (!selected) return;
      const text = selectedText(selected); menuRef.current?.hidePopover();
      const messageId = selected.nativeId ?? selected.id;
      if (options.onAskSidechat) options.onAskSidechat({ messageId, text });
      else window.dispatchEvent(new CustomEvent('aside:ask-sidechat', { detail: { sessionId: options.sessionId, messageId, text } }));
    }}><MessageCircleQuestion size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Ask in side chat</button>}
    {(options.onNavigateTurns || selectedMessage?.turn !== undefined) && <button type="button" role="menuitem" {...stylex.props(styles.item)} onClick={() => {
      const selected = selectedRef.current; if (!selected) return;
      menuRef.current?.hidePopover();
      if (options.onNavigateTurns) options.onNavigateTurns();
      else { selected.article.scrollIntoView({ block: 'center', behavior: 'smooth' }); history.replaceState(history.state, '', location.pathname + location.search + '#turn-' + selected.turn); }
    }}><CornerUpRight size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />{selectedMessage?.turn === undefined ? 'Jump to turn' : `Jump to turn ${selectedMessage.turn + 1}`}</button>}
    <button type="button" role="menuitem" {...stylex.props(styles.item)} onClick={() => {
      const selected = selectedRef.current;
      if (!selected) return;
      menuRef.current?.hidePopover(); setSelectableId(selected.article.dataset.messageId);
      selected.article.focus({ preventScroll: true });
      const range = document.createRange(); range.selectNodeContents(selected.article);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    }}><TextSelect size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Select text</button>
  </div>;
  const overlay = editTarget && <Dialog title="Edit message" onClose={() => { setEditTarget(undefined); setSaving(false); }}>
    <DialogDescription>Editing this message updates the conversation from this point.</DialogDescription>
    <textarea autoFocus aria-label="Message" rows={6} value={editText} {...stylex.props(ui.field, styles.editor)} onChange={event => setEditText(event.target.value)} />
    <DialogActions><Button onClick={() => setEditTarget(undefined)}>Cancel</Button><Button variant="primary" disabled={!editText.trim() || isSaving} onClick={() => { void saveEdit(); }}>Save</Button></DialogActions>
  </Dialog>;
  return { handlers, menu: <>{menu}{overlay}</>, selectableId };

  async function branchMessage() {
    const selected = selectedRef.current;
    if (!selected || !options.request || !options.sessionId) return;
    menuRef.current?.hidePopover();
    try {
      const response = await options.request('/api/native/sessions/' + encodeURIComponent(options.sessionId) + '/command', { method: 'POST', body: JSON.stringify(selected.nativeId ? { command: 'branch', messageId: selected.nativeId } : { command: 'branch', seq: selected.seq }) });
      const value = await response.json() as unknown;
      const sessionId = readSessionId(value);
      if (!sessionId) throw new Error();
      notify('Conversation branched.', 'success');
      if (options.onOpenSession) options.onOpenSession(sessionId);
      else location.assign('/c/' + encodeURIComponent(sessionId));
    } catch { notify('Could not branch the conversation.', 'error'); }
  }

  async function saveEdit() {
    if (!editTarget || !options.request || !options.sessionId || !editText.trim()) return;
    setSaving(true);
    try {
      await options.request('/api/native/sessions/' + encodeURIComponent(options.sessionId) + '/command', { method: 'POST', body: JSON.stringify(editTarget.nativeId ? { command: 'edit-user-message', messageId: editTarget.nativeId, content: editText.trim() } : { command: 'edit-user-message', seq: editTarget.seq, content: editText.trim() }) });
      setEditTarget(undefined); setSaving(false); notify('Message updated.', 'success'); await options.onRefreshMessages?.();
    } catch { setSaving(false); notify('Could not edit the message.', 'error'); }
  }


}

function selectedText(message: SelectedMessage) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return message.text;
  const range = selection.getRangeAt(0);
  return message.article.contains(range.commonAncestorContainer) ? selection.toString().trim() || message.text : message.text;
}

function readSessionId(value: unknown) {
  if (typeof value !== 'object' || value === null) return;
  const result = Reflect.get(value, 'result');
  const session = typeof result === 'object' && result !== null ? Reflect.get(result, 'session') : undefined;
  const candidates = [Reflect.get(value, 'sessionId'), Reflect.get(value, 'id'), typeof result === 'object' && result !== null ? Reflect.get(result, 'sessionId') ?? Reflect.get(result, 'id') : undefined, typeof session === 'object' && session !== null ? Reflect.get(session, 'id') : undefined];
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
}

const styles = stylex.create({
  menu: { position: 'fixed', inset: 'auto', margin: 0, width: 'min(240px, calc(100vw - 16px))', padding: 6, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 22, backgroundColor: tokens.surface, color: tokens.text, boxShadow: '0 8px 32px rgb(0 0 0 / .22)', overflowY: 'auto' },
  item: { display: 'flex', alignItems: 'center', gap: 14, width: '100%', minHeight: 48, padding: '0 14px', borderWidth: 0, borderRadius: 16, fontFamily: tokens.font, fontSize: '1rem', color: tokens.text, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, textAlign: 'left' },
  editor: { width: '100%', minHeight: 132, resize: 'vertical', lineHeight: 1.5 },
});
