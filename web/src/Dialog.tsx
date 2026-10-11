import type { ComponentProps, ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import * as stylex from '@stylexjs/stylex';
import { ChevronLeft, X } from 'lucide-react';
import { usePresence } from 'motion/react';
import { IconButton, ICON_STROKE, resolveDialogReturnFocus } from './ui';
import { tokens } from './tokens.stylex';

export function Dialog({ title, description, back, children, onClose, initialFocus }: { title: string; description?: string; back?: { label: string; onClick: () => void }; children: ReactNode; onClose: () => void; initialFocus?: BaseDialog.Popup.Props['initialFocus'] }) {
  const [isPresent, safeToRemove] = usePresence();
  const [portalContainer, setPortalContainer] = useState<HTMLElement>();
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const previousTitleRef = useRef(title);
  useLayoutEffect(() => {
    if (previousTitleRef.current === title) return;
    previousTitleRef.current = title;
    headerRef.current?.querySelector('button')?.focus({ preventScroll: true });
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

  if (!portalContainer) return undefined;
  return <BaseDialog.Root open={isPresent} onOpenChange={isOpen => { if (!isOpen && isPresent) onClose(); }} onOpenChangeComplete={isOpen => { if (!isOpen) safeToRemove?.(); }}>
    <BaseDialog.Portal container={portalContainer}>
      <BaseDialog.Backdrop data-app-dialog-backdrop="" {...stylex.props(styles.backdrop)} />
      <BaseDialog.Viewport ref={viewportRef} {...stylex.props(styles.viewport)}>
        <BaseDialog.Popup data-app-dialog="" {...stylex.props(styles.popup)} initialFocus={initialFocus} onKeyDown={event => { if (event.key === 'Tab') event.stopPropagation(); }} finalFocus={() => {
          if (portalContainer instanceof HTMLDialogElement && portalContainer.open) return returnFocus?.isConnected && portalContainer.contains(returnFocus) ? returnFocus : portalContainer.querySelector<HTMLElement>('button:not([data-overlay-backdrop]):not(:disabled)');
          return resolveDialogReturnFocus(returnFocus, title);
        }}>
          <div ref={headerRef} data-app-dialog-header="" {...stylex.props(styles.header)}>{back && <IconButton label={back.label} onClick={back.onClick}><ChevronLeft size={22} strokeWidth={ICON_STROKE} aria-hidden="true" /></IconButton>}<div {...stylex.props(styles.heading)}><BaseDialog.Title {...stylex.props(styles.title)}>{title}</BaseDialog.Title>{description && <BaseDialog.Description {...stylex.props(styles.subtitle)}>{description}</BaseDialog.Description>}</div><BaseDialog.Close render={<IconButton label="Close"><X size={22} strokeWidth={ICON_STROKE} aria-hidden="true" /></IconButton>} /></div>
          <div key={title} data-app-dialog-body="" {...stylex.props(styles.body)}>{children}</div>
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
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
});
