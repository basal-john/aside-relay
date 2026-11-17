import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { X } from 'lucide-react';
import { tokens } from './tokens.stylex';
import { parseUsage, type UsageSnapshot, type UsageWindow } from './responses';
import { useAutoRefresh } from './useAutoRefresh';
import {
  dailyBudget,
  elapsedPercent,
  paceLabel,
  resetText,
  shortModelLabel,
  usageTone,
  windowTitle,
} from './usageMetrics';
import { ICON_STROKE } from './ui';
import type { UseChat } from './types';

const USAGE_PROVIDERS = new Set(['aside', 'claude-code', 'kimi-code', 'openai-codex', 'xai-grok-oauth']);
const REFRESH_MS = 60_000;
const PANEL_MARGIN = 8;

export function UsageBadge({ chat, provider, modelId, modelName }: {
  chat: UseChat; provider?: string; modelId?: string; modelName?: string;
}) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>();
  const [fetchedAt, setFetchedAt] = useState<string>();
  const [isOpen, setOpen] = useState(false);
  const [isRefreshing, setRefreshing] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const canLoad = chat.isReady && !chat.authError && !!provider && USAGE_PROVIDERS.has(provider);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!provider || !USAGE_PROVIDERS.has(provider)) {
      setSnapshot(undefined);
      return;
    }
    try {
      const response = await chat.request('/api/usage?provider=' + encodeURIComponent(provider), signal ? { signal } : undefined);
      if (!response.ok) return;
      const next = parseUsage(await response.json());
      setSnapshot(current => {
        if (current && current.providerId === next.providerId && current.windows.length && !next.windows.length) return current;
        return next;
      });
      if (next.windows.length) setFetchedAt(new Date().toISOString());
    } catch {
      if (signal?.aborted) return;
    }
  }, [chat, provider]);

  useAutoRefresh(refresh, REFRESH_MS, canLoad);

  const windows = snapshot?.windows ?? [];
  const primary = windows.find(window => window.kind === 'five_hour') ?? windows[0];
  if (!canLoad || !primary) return null;

  const label = windows.map(window => `${window.usedPercent}% ${window.label}`).join(', ');
  const title = shortModelLabel(modelId, modelName);

  return <>
    <button ref={anchorRef} type="button" aria-label={'Usage, ' + label} aria-haspopup="dialog" aria-expanded={isOpen} {...stylex.props(styles.badge, toneStyle(primary.usedPercent))} onClick={() => setOpen(open => !open)}>
      <span {...stylex.props(styles.percent)}>{primary.usedPercent}%</span>
    </button>
    {isOpen && anchorRef.current && <UsagePanel
      anchor={anchorRef.current}
      title={title}
      modelId={modelId}
      provider={provider}
      windows={windows}
      fetchedAt={fetchedAt}
      isRefreshing={isRefreshing}
      onRefresh={() => {
        setRefreshing(true);
        void refresh().finally(() => setRefreshing(false));
      }}
      onClose={() => setOpen(false)}
    />}
  </>;
}

function UsagePanel({ anchor, title, modelId, provider, windows, fetchedAt, isRefreshing, onRefresh, onClose }: {
  anchor: HTMLElement;
  title: string;
  modelId?: string;
  provider?: string;
  windows: UsageWindow[];
  fetchedAt?: string;
  isRefreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const now = new Date();
  const updated = fetchedAt
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(fetchedAt))
    : null;
  const hasTick = windows.some(window => elapsedPercent(window, now) != null);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const viewport = window.visualViewport;
    const viewTop = viewport?.offsetTop ?? 0;
    const viewBottom = viewTop + (viewport?.height ?? innerHeight);
    const composer = document.querySelector<HTMLElement>('#composer form') ?? document.querySelector<HTMLElement>('#composer') ?? anchor.closest('form');
    const rail = composer?.getBoundingClientRect() ?? anchor.getBoundingClientRect();
    panel.style.width = Math.round(rail.width) + 'px';
    panel.style.left = Math.round(rail.left) + 'px';
    panel.style.right = 'auto';
    panel.style.maxHeight = Math.max(0, rail.top - viewTop - PANEL_MARGIN * 2) + 'px';
    panel.showPopover();
    const box = panel.getBoundingClientRect();
    const top = Math.max(viewTop + PANEL_MARGIN, rail.top - box.height - PANEL_MARGIN);
    panel.style.top = Math.min(top, viewBottom - box.height - PANEL_MARGIN) + 'px';
    panel.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => { if (panel.matches(':popover-open')) panel.hidePopover(); };
  }, [anchor, windows, isRefreshing]);

  useLayoutEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target) && !anchor.contains(event.target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.visualViewport?.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.visualViewport?.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} popover="manual" role="dialog" aria-label="Usage details" {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.heading)}>
          <div {...stylex.props(styles.title)}>{title}</div>
          <div {...stylex.props(styles.subtitle)}>{modelId ?? 'no model'}</div>
        </div>
        <div {...stylex.props(styles.headerMeta)}>
          <span {...stylex.props(styles.provider)}>{provider}</span>
          <button type="button" aria-label="Close usage details" {...stylex.props(styles.close)} onClick={onClose}><X size={18} strokeWidth={ICON_STROKE} /></button>
        </div>
      </div>
      {windows.map(window => <WindowRow key={window.kind} window={window} now={now} />)}
      <div {...stylex.props(styles.footer)}>
        <span>{updated ? `Updated ${updated}` : 'Not loaded yet'}{hasTick ? ' · tick = time gone in window' : ''}</span>
        <button type="button" disabled={isRefreshing} {...stylex.props(styles.refresh)} onClick={onRefresh}>{isRefreshing ? 'Refreshing…' : 'Refresh'}</button>
      </div>
    </div>,
    document.body,
  );
}

function WindowRow({ window, now }: { window: UsageWindow; now: Date }) {
  const used = window.usedPercent;
  const elapsed = elapsedPercent(window, now);
  const pace = paceLabel(used, elapsed);
  const budget = dailyBudget(window, now);
  const reset = resetText(window.resetsAt, now);
  const tone = usageTone(used);
  return <div {...stylex.props(styles.row)}>
    <div {...stylex.props(styles.rowHead)}>
      <span {...stylex.props(styles.rowTitle)}>{windowTitle(window.kind)}</span>
      <span {...stylex.props(styles.rowValue)}>
        <span {...stylex.props(styles.rowPercent, toneStyle(used))}>{Math.round(used)}%</span>
        <span {...stylex.props(styles.rowUsed)}>used</span>
      </span>
    </div>
    <div {...stylex.props(styles.track)}>
      <div {...stylex.props(styles.fill, toneFill(tone))} style={{ width: `${Math.max(used, 0.5)}%` }} />
      {elapsed != null && <div aria-hidden="true" title={`${Math.round(elapsed)}% of this window's time has gone`} {...stylex.props(styles.tick)} style={{ left: `calc(${elapsed}% - 1px)` }} />}
    </div>
    <div {...stylex.props(styles.meta)}>
      <span>{pace && elapsed != null ? `${pace} · ${Math.round(elapsed)}% of time gone` : ''}</span>
      <span>{reset ? `resets ${reset}` : ''}</span>
    </div>
    {budget && <div {...stylex.props(styles.budget)}>{`budget ~${Math.round(budget.perDay)}% a day · stay under ${Math.round(budget.keepUnder)}% by ${budget.until}`}</div>}
  </div>;
}

function toneStyle(usedPercent: number) {
  const tone = usageTone(usedPercent);
  if (tone === 'bad') return styles.critical;
  if (tone === 'warn') return styles.warn;
  return undefined;
}

function toneFill(tone: ReturnType<typeof usageTone>) {
  if (tone === 'bad') return styles.fillBad;
  if (tone === 'warn') return styles.fillWarn;
  return styles.fillOk;
}

const styles = stylex.create({
  badge: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 36, minWidth: 40, padding: '0 8px', borderWidth: 0, borderRadius: 999, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.muted, fontFamily: tokens.font, flexShrink: 0 },
  percent: { fontSize: '.75rem', fontWeight: 650, fontVariantNumeric: 'tabular-nums', letterSpacing: '-.1px' },
  panel: { position: 'fixed', inset: 'auto', margin: 0, width: 'auto', maxWidth: '100%', boxSizing: 'border-box', padding: '14px 14px 12px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.glassBorder, borderRadius: 26, backgroundColor: '#0a0a0b', color: tokens.text, boxShadow: '0 12px 40px rgb(0 0 0 / .45)', overflowY: 'auto', fontFamily: tokens.font },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
  heading: { minWidth: 0, flex: 1 },
  title: { fontSize: '0.9375rem', fontWeight: 650, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  subtitle: { marginTop: 2, color: tokens.muted, fontSize: '0.6875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  headerMeta: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  provider: { color: tokens.muted, fontSize: '0.6875rem' },
  close: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderWidth: 0, borderRadius: 10, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.muted },
  row: { marginTop: 16 },
  rowHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  rowTitle: { fontSize: '0.8125rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowValue: { display: 'inline-flex', alignItems: 'baseline', gap: 2, flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  rowPercent: { fontSize: '1.25rem', fontWeight: 650, lineHeight: 1 },
  rowUsed: { color: tokens.muted, fontSize: '0.75rem' },
  track: { position: 'relative', height: 8, marginTop: 6, marginBottom: 4, borderRadius: 999, backgroundColor: '#1c1c1f', overflow: 'hidden' },
  fill: { position: 'absolute', insetBlock: 0, left: 0, borderRadius: 999 },
  fillOk: { backgroundColor: 'color-mix(in srgb, #f5f5f5 72%, transparent)' },
  fillWarn: { backgroundColor: '#e0a23a' },
  fillBad: { backgroundColor: '#e5534b' },
  tick: { position: 'absolute', top: -3, bottom: -3, width: 2, borderRadius: 1, backgroundColor: '#f5f5f5', opacity: 0.6 },
  meta: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '2px 8px', color: tokens.muted, fontSize: '0.6875rem', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  budget: { marginTop: 2, color: tokens.muted, fontSize: '0.6875rem', fontVariantNumeric: 'tabular-nums' },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: tokens.border, color: tokens.muted, fontSize: '0.6875rem' },
  refresh: { minHeight: 36, padding: '0 12px', borderWidth: 0, borderRadius: 10, backgroundColor: { default: '#1c1c1f', ':hover': '#26262a' }, color: tokens.text, fontSize: '0.75rem', flexShrink: 0 },
  warn: { color: '#e0a23a' },
  critical: { color: '#e5534b' },
});
