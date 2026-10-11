import { APP_NAME } from './brand';
import { useCallback, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronRight, SlidersHorizontal } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { UseChat } from './types';
import { ICON_STROKE, styles as ui } from './ui';
import { Button } from './Button';
import { tokens } from './tokens.stylex';
import { formatRequestError } from './errors';
import { TEXT_SIZES, THEME_PRESETS, UI_FONTS, CODE_FONTS, ACCENT_COLORS, DEFAULT_ACCENT, type Appearance, type ThemeMode } from './theme';
import { useAutoRefresh } from './useAutoRefresh';
import type { PushNotifications } from './notifications';
import { parseHealth } from './responses';

type Health = ReturnType<typeof parseHealth>;

export function Settings({ chat, notify, notifications, isDarkMode, onThemeToggle, textSize, onTextSizeChange, onWorkspace, themeMode, onThemeModeChange, appearance, onAppearanceChange }: { chat: UseChat; notify: (text: string, kind?: 'error' | 'success') => void; notifications: PushNotifications; isDarkMode: boolean; onThemeToggle: () => void; textSize: number; onTextSizeChange: (size: number) => void; onWorkspace?: () => void; themeMode: ThemeMode; onThemeModeChange: (mode: ThemeMode) => void; appearance: Appearance; onAppearanceChange: (value: Appearance) => void }) {
  const shouldReduceMotion = useReducedMotion();
  const [token, setToken] = useState(''); const [isSaving, setSaving] = useState(false); const [health, setHealth] = useState<Health>(); const [error, setError] = useState('');
  const [browserStatus, setBrowserStatus] = useState<'checking' | 'connected' | 'unavailable'>('checking');
  const refresh = useCallback(async (signal: AbortSignal) => {
    const [healthResult, browserResult] = await Promise.allSettled([
      chat.request('/api/health', { cache: 'no-store', signal }).then(response => response.json()).then(parseHealth),
      chat.request('/api/tabs?refresh=true', { cache: 'no-store', signal }),
    ]);
    if (signal.aborted) return;
    setError('');
    if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
    else { setHealth(undefined); setError('Could not check the connection.'); }
    setBrowserStatus(browserResult.status === 'fulfilled' ? 'connected' : 'unavailable');
    if (browserResult.status === 'rejected') setError(formatRequestError({ message: browserResult.reason instanceof Error ? browserResult.reason.message : undefined }));
  }, [chat.request]);
  useAutoRefresh(refresh, 5_000);
  return <div {...stylex.props(styles.content)}>
    {onWorkspace ? <section><h3 {...stylex.props(styles.heading)}>{APP_NAME}</h3><button type="button" {...stylex.props(styles.workspace)} onClick={onWorkspace}><SlidersHorizontal size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span {...stylex.props(styles.workspaceText)}><strong>Workspace & preferences</strong><span {...stylex.props(ui.muted)}>Projects, routines, memory, connections, providers and native preferences</span></span><ChevronRight size={18} strokeWidth={ICON_STROKE} aria-hidden="true" /></button></section> : undefined}
    <section><h3 {...stylex.props(styles.heading)}>Connection</h3><div {...stylex.props(styles.statusRow)}><span>Bridge</span><span {...stylex.props(ui.muted)}>{chat.isConnected ? 'Connected' : 'Reconnecting…'}</span></div>
      <div {...stylex.props(styles.statusRow)}><span>Aside browser</span><span {...stylex.props(ui.muted)}>{health ? health.asideApp ? 'Running' : 'Not running' : error ? 'Unavailable' : 'Checking…'}</span></div>
      <div {...stylex.props(styles.statusRow)}><span>Browser</span><span {...stylex.props(ui.muted)}>{browserStatus === 'connected' ? 'Connected' : browserStatus === 'unavailable' ? 'Unavailable' : 'Checking…'}</span></div>
      {error && <p role="alert" {...stylex.props(ui.muted)}>{error}</p>}
      {health && !health.asideApp && <div {...stylex.props(styles.actions)}><Button onClick={async () => { try { await chat.request('/api/aside/launch', { method: 'POST' }); notify('Aside opened.', 'success'); } catch { notify('Could not open Aside.', 'error'); } }}>Open Aside</Button></div>}
    </section>
    <section><h3 {...stylex.props(styles.heading)}>Access token</h3><p id="access-token-help" {...stylex.props(ui.muted)}>Only needed when your connection does not sign you in automatically.</p>
      <form onSubmit={async event => { event.preventDefault(); setSaving(true); try { if (await chat.saveToken(token)) setToken(''); } finally { setSaving(false); } }}><input {...stylex.props(ui.field)} type="password" value={token} autoComplete="off" aria-label="Access token" aria-describedby="access-token-help" placeholder="Paste your access token" onChange={event => setToken(event.target.value)} /><Button type="submit" variant="primary" {...stylex.props(styles.save)} disabled={isSaving || !token.trim()}>{isSaving ? 'Connecting…' : 'Connect'}</Button></form>
    </section>
    <section><h3 {...stylex.props(styles.heading)}>Notifications</h3>
      <div {...stylex.props(styles.statusRow)}><span>Response notifications</span><span {...stylex.props(ui.muted)}>{notifications.status === 'enabled' ? 'Enabled' : notifications.status === 'checking' ? 'Checking…' : notifications.status === 'denied' ? 'Blocked' : notifications.status === 'unavailable' ? 'Unavailable' : 'Off'}</span></div>
      <p {...stylex.props(ui.muted)}>{notifications.unavailableReason || (notifications.status === 'denied' ? `Allow notifications for ${APP_NAME} in your device settings.` : 'Get notified when a response finishes while you are away from the app. Tap a notification to open its conversation.')}</p>
      {notifications.status !== 'unavailable' && notifications.status !== 'denied' && <Button disabled={notifications.isUpdating || notifications.status === 'checking' || !chat.isReady || !!chat.authError} onClick={() => { void (notifications.status === 'enabled' ? notifications.disable() : notifications.enable()); }}>{notifications.isUpdating ? 'Updating…' : notifications.status === 'enabled' ? 'Turn off notifications' : 'Enable notifications'}</Button>}
    </section>
    <section><h3 {...stylex.props(styles.heading)}>Appearance</h3><div {...stylex.props(styles.statusRow)}><span>Dark mode</span><motion.button type="button" role="switch" aria-label="Dark mode" aria-checked={isDarkMode} whileTap={shouldReduceMotion ? undefined : { scale: .94 }} onClick={onThemeToggle} {...stylex.props(styles.themeSwitch)}><motion.span animate={{ backgroundColor: isDarkMode ? 'var(--primary)' : 'var(--hover)' }} transition={{ duration: shouldReduceMotion ? 0 : .18 }} {...stylex.props(styles.switchTrack)}><motion.span animate={{ x: isDarkMode ? 20 : 0 }} transition={shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 34 }} {...stylex.props(styles.switchThumb)} /></motion.span></motion.button></div>
      <div {...stylex.props(styles.statusRow)}><label htmlFor="text-size">Text size</label><select id="text-size" value={textSize} onChange={event => onTextSizeChange(Number(event.target.value))} {...stylex.props(styles.textSize)}>{TEXT_SIZES.map(size => <option key={size} value={size}>{size}%</option>)}</select></div>
      <div {...stylex.props(styles.statusRow)}><label htmlFor="theme-mode">Theme mode</label><select id="theme-mode" value={themeMode} onChange={event => onThemeModeChange(event.target.value as ThemeMode)} {...stylex.props(styles.textSize)}><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></div>
      {(['light', 'dark'] as const).map(scheme => <div key={scheme} {...stylex.props(styles.statusRow)}><label htmlFor={scheme + '-theme'}>{scheme === 'light' ? 'Light theme' : 'Dark theme'}</label><select id={scheme + '-theme'} value={scheme === 'light' ? appearance.lightPreset : appearance.darkPreset} onChange={event => onAppearanceChange({ ...appearance, [scheme === 'light' ? 'lightPreset' : 'darkPreset']: event.target.value })} {...stylex.props(styles.textSize)}><option value="relay">aside-relay</option>{THEME_PRESETS.filter(preset => preset.scheme === scheme).map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></div>)}
      <div {...stylex.props(styles.statusRow)}><label htmlFor="primary-color">Primary color</label><div {...stylex.props(styles.colors)}><button type="button" {...stylex.props(styles.resetColor)} disabled={!appearance.accent} onClick={() => onAppearanceChange({ ...appearance, accent: '' })}>Theme default</button><input id="primary-color" type="color" value={appearance.accent || THEME_PRESETS.find(preset => preset.id === (isDarkMode ? appearance.darkPreset : appearance.lightPreset))?.accent || DEFAULT_ACCENT} onChange={event => onAppearanceChange({ ...appearance, accent: event.target.value })} {...stylex.props(styles.colorPicker)} /></div></div>
      <div role="group" aria-label="Primary color presets" {...stylex.props(styles.swatches)}>{ACCENT_COLORS.map(color => <button key={color} type="button" aria-label={'Primary color ' + color} aria-pressed={appearance.accent === color} onClick={() => onAppearanceChange({ ...appearance, accent: color })} {...stylex.props(styles.swatch, appearance.accent === color && styles.selectedSwatch)} style={{ backgroundColor: color }} />)}</div>
      {([{ key: 'uiFont', label: 'UI font', fonts: UI_FONTS }, { key: 'contentFont', label: 'Content font', fonts: UI_FONTS }, { key: 'codeFont', label: 'Code font', fonts: CODE_FONTS }] as const).map(({ key, label, fonts }) => <div key={key} {...stylex.props(styles.statusRow)}><label htmlFor={key}>{label}</label><select id={key} value={appearance[key]} onChange={event => onAppearanceChange({ ...appearance, [key]: event.target.value })} {...stylex.props(styles.textSize)}>{fonts.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</select></div>)}
      <p {...stylex.props(ui.muted)}>The interface, messages and code can each use a different font.</p></section>
  </div>;
}

const styles = stylex.create({
  content: { display: 'flex', flexDirection: 'column', gap: 24 },
  heading: { fontSize: '0.875rem', fontWeight: 600, margin: '0 0 12px' },
  statusRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, paddingTop: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, fontSize: '0.875rem', overflowWrap: 'anywhere' },
  colors: { display: 'flex', alignItems: 'center', gap: 10 },
  resetColor: { borderWidth: 0, backgroundColor: 'transparent', color: tokens.muted, fontSize: '.75rem', minHeight: 40, padding: '0 8px' },
  colorPicker: { width: 44, height: 40, padding: 4, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 12, backgroundColor: tokens.surface },
  swatches: { display: 'flex', flexWrap: 'wrap', gap: 10, paddingTop: 12, paddingBottom: 12 },
  swatch: { width: 34, height: 34, borderRadius: '50%', borderWidth: 3, borderStyle: 'solid', borderColor: 'transparent', boxShadow: '0 0 0 1px var(--border)' },
  selectedSwatch: { borderColor: tokens.text },
  textSize: { minHeight: 44, maxWidth: '100%', borderWidth: 0, padding: '0 8px', borderRadius: 12, backgroundColor: tokens.surface, color: tokens.text },
  actions: { display: 'flex', gap: 8, marginTop: 16 },
  save: { width: '100%', marginTop: 12 },
  themeSwitch: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 44, borderWidth: 0, padding: 0, backgroundColor: 'transparent' },
  switchTrack: { display: 'flex', alignItems: 'center', width: 48, height: 28, padding: 4, borderRadius: 20, backgroundColor: tokens.hover },
  switchThumb: { width: 20, height: 20, borderRadius: '50%', backgroundColor: tokens.mediaWhite, boxShadow: '0 1px 3px rgb(0 0 0 / .2)' },
  workspace: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 64, padding: '10px 12px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 16, backgroundColor: { default: tokens.surface, ':hover': tokens.hover }, color: tokens.text, textAlign: 'left' },
  workspaceText: { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 2, overflowWrap: 'anywhere' },
});
