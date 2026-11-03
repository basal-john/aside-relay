import type { ComponentProps, ReactNode } from 'react';
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import * as stylex from '@stylexjs/stylex';
import { ChevronLeft, X } from 'lucide-react';
import { usePresence } from 'motion/react';
import { IconButton, ICON_STROKE, resolveDialogReturnFocus } from './ui';
import { tokens } from './tokens.stylex';
import { TabBar, TabContext, useIsPhone } from './TabBar';

export function Dialog({ title, description, back, children, onClose, initialFocus }: { title: string; description?: string; back?: { label: string; onClick: () => void }; children: ReactNode; onClose: () => void; initialFocus?: BaseDialog.Popup.Props['initialFocus'] }) {
  const [isPresent, safeToRemove] = usePresence();
  const [portalContainer, setPortalContainer] = useState<HTMLElement>();
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const previousTitleRef = useRef(title);
  const popupRef = useRef<HTMLDivElement>(null);
  const tabs = useContext(TabContext);
  const isPhone = useIsPhone();
  const isPage = !!tabs && isPhone;
  const isSheet = !tabs && isPhone;
  useLayoutEffect(() => {
    if (previousTitleRef.current === title) return;
    previousTitleRef.current = title;
    const header = headerRef.current;
    const target = [...header?.querySelectorAll<HTMLElement>('button') ?? []].find(button => button.getClientRects().length > 0) ?? header?.querySelector<HTMLElement>('[data-dialog-title]');
    target?.focus({ preventScroll: true });
  }, [title]);
  useLayoutEffect(() => {
    setPortalContainer([...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(dialog => getComputedStyle(dialog).pointerEvents !== 'none').at(-1) ?? document.body);
  }, []);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => {
      viewportRef.current?.style.setProperty('--dialog-height', viewport.height + 'px');
      viewportRef.current?.style.setProperty('--dialog-top', viewport.offsetTop + 'px');
    };
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    return () => { viewport.removeEventListener('resize', resize); viewport.removeEventListener('scroll', resize); };
  }, [portalContainer]);

  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!isSheet || !popup) return;
    let gesture: { id: number; y: number; offset: number } | undefined;
    const start = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !(event.target instanceof Element) || !event.target.closest('[data-sheet-grip]')) return;
      gesture = { id: event.pointerId, y: event.clientY, offset: 0 };
    };
    const move = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      gesture.offset = Math.max(0, event.clientY - gesture.y);
      popup.style.translate = `0 ${gesture.offset}px`;
    };
    const finish = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const shouldClose = gesture.offset > 96;
      gesture = undefined;
      popup.style.removeProperty('translate');
      if (shouldClose && event.type === 'pointerup') onClose();
    };
    popup.addEventListener('pointerdown', start);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => { popup.removeEventListener('pointerdown', start); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); };
  }, [isSheet, onClose, portalContainer]);

  if (!portalContainer) return undefined;
  return <BaseDialog.Root open={isPresent} onOpenChange={isOpen => { if (!isOpen && isPresent) onClose(); }} onOpenChangeComplete={isOpen => { if (!isOpen) safeToRemove?.(); }}>
    <BaseDialog.Portal container={portalContainer}>
      <BaseDialog.Backdrop data-app-dialog-backdrop="" {...stylex.props(styles.backdrop)} />
      <BaseDialog.Viewport ref={viewportRef} {...stylex.props(styles.viewport, isSheet && styles.sheetViewport, isPage && styles.pageViewport)}>
        <BaseDialog.Popup ref={popupRef} data-app-dialog="" data-dialog-variant={isPage ? 'page' : isSheet ? 'sheet' : 'card'} {...stylex.props(styles.popup, isSheet && styles.sheetPopup, isPage && styles.pagePopup)} initialFocus={initialFocus} onKeyDown={event => { if (event.key === 'Tab') event.stopPropagation(); }} finalFocus={() => {
          if (portalContainer instanceof HTMLDialogElement && portalContainer.open) return returnFocus?.isConnected && portalContainer.contains(returnFocus) ? returnFocus : portalContainer.querySelector<HTMLElement>('button:not([data-overlay-backdrop]):not(:disabled)');
          return resolveDialogReturnFocus(returnFocus, title);
        }}>
          {isSheet && <div data-sheet-grip="" aria-hidden="true" {...stylex.props(styles.grip)}><span {...stylex.props(styles.gripBar)} /></div>}
          <div ref={headerRef} data-app-dialog-header="" data-sheet-grip={isSheet ? '' : undefined} {...stylex.props(styles.header, isSheet && styles.sheetHeader, isPage && styles.pageHeader)}>{back && <IconButton label={back.label} onClick={back.onClick}><ChevronLeft size={22} strokeWidth={ICON_STROKE} aria-hidden="true" /></IconButton>}<div {...stylex.props(styles.heading)}><BaseDialog.Title data-dialog-title="" tabIndex={-1} {...stylex.props(styles.title, isPage && !back && styles.largeTitle)}>{title}</BaseDialog.Title>{description && <BaseDialog.Description {...stylex.props(styles.subtitle)}>{description}</BaseDialog.Description>}</div><BaseDialog.Close render={<IconButton label="Close" {...stylex.props(isPage && styles.pageClose)}><X size={22} strokeWidth={ICON_STROKE} aria-hidden="true" /></IconButton>} /></div>
          <div key={title} data-app-dialog-body="" {...stylex.props(styles.body, isPage && styles.pageBody)}><TabContext.Provider value={undefined}>{children}</TabContext.Provider></div>
          {isPage && <TabBar />}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  </BaseDialog.Root>;
}

export function DialogDescription({ className, ...props }: Omit<ComponentProps<typeof BaseDialog.Description>, 'className'> & { className?: string }) {
  return <BaseDialog.Description {...props} className={[stylex.props(styles.description).className, className].filter(Boolean).join(' ')} />;
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.actions)}>{children}</div>;
}

const styles = stylex.create({
  backdrop: { position: 'fixed', inset: 0, zIndex: 20, backgroundColor: 'rgb(0 0 0 / .5)' },
  viewport: { position: 'fixed', top: 'var(--dialog-top, 0px)', left: 0, width: '100%', height: 'var(--dialog-height, 100dvh)', zIndex: 21, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))', overflow: 'hidden', pointerEvents: 'none' },
  popup: { display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 420, maxHeight: '100%', borderRadius: 24, backgroundColor: tokens.surface, color: tokens.text, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, boxShadow: '0 20px 80px rgb(0 0 0 / .3)', overflow: 'hidden', pointerEvents: 'auto' },
  header: { display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '22px 22px 16px' },
  heading: { flex: 1, minWidth: 0 },
  subtitle: { margin: '4px 0 0', fontSize: '.8125rem', lineHeight: 1.5, color: tokens.muted, overflowWrap: 'anywhere' },
  body: { minHeight: 0, minWidth: 0, padding: '0 22px 22px', overflowY: 'auto', overscrollBehavior: 'contain' },
  title: { fontSize: '1.125rem', fontWeight: 650, lineHeight: 1.3, margin: 0, minWidth: 0 },
  description: { fontSize: '0.875rem', lineHeight: 1.6, color: tokens.muted, margin: '0 0 16px', overflowWrap: 'anywhere' },
  sheetViewport: { alignItems: 'flex-end', padding: '0 env(safe-area-inset-right) 0 env(safe-area-inset-left)' },
  sheetPopup: { maxWidth: 'none', maxHeight: 'calc(100% - max(24px, env(safe-area-inset-top)))', borderWidth: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: tokens.canvas, paddingBottom: 'env(safe-area-inset-bottom)', boxShadow: '0 -10px 40px rgb(0 0 0 / .18)' },
  grip: { display: 'flex', justifyContent: 'center', alignItems: 'center', height: 22, flexShrink: 0, touchAction: 'none', cursor: 'grab' },
  gripBar: { width: 36, height: 5, borderRadius: 999, backgroundColor: tokens.controlBorder },
  sheetHeader: { paddingTop: 4, touchAction: 'none' },
  pageViewport: { padding: 0 },
  pagePopup: { maxWidth: 'none', width: '100%', height: '100%', maxHeight: 'none', borderRadius: 0, borderWidth: 0, boxShadow: 'none', backgroundColor: tokens.canvas },
  pageHeader: { padding: 'calc(10px + env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 8px max(16px, env(safe-area-inset-left))' },
  largeTitle: { fontSize: '2rem', fontWeight: 700, letterSpacing: '-.5px', lineHeight: 1.2 },
  pageClose: { display: 'none' },
  pageBody: { flex: 1, padding: '0 max(16px, env(safe-area-inset-right)) calc(96px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))' },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
});
