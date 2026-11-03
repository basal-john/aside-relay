import { createContext, useContext, useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { LayoutGrid, MessageCircle, Settings2 } from 'lucide-react';
import { BrowserIcon, ICON_STROKE } from './ui';
import { tokens } from './tokens.stylex';

export type Tab = 'chats' | 'browser' | 'workspace' | 'settings';

/** Present while a top-level phone page (Chats, Browser, Workspace, Settings) is rendering, so its container draws the tab bar. */
export const TabContext = createContext<{ current: Tab; select: (tab: Tab) => void } | undefined>(undefined);

export const PHONE_QUERY = '(max-width: 820px)';

/** Tracks whether the viewport is phone-sized, matching the drawer breakpoint in App. */
export function useIsPhone() {
  const [matches, setMatches] = useState(() => matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const media = matchMedia(PHONE_QUERY);
    const update = () => setMatches(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return matches;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'chats', label: 'Chats' },
  { id: 'browser', label: 'Browser' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'settings', label: 'Settings' },
];

/** Floating bottom navigation for the phone layout. Renders nothing outside a TabContext or on wide screens. */
export function TabBar() {
  const tabs = useContext(TabContext);
  const isPhone = useIsPhone();
  if (!tabs || !isPhone) return undefined;
  return <nav aria-label="Sections" {...stylex.props(styles.bar)}>
    {TABS.map(tab => {
      const isCurrent = tab.id === tabs.current;
      return <button key={tab.id} type="button" aria-current={isCurrent ? 'page' : undefined} {...stylex.props(styles.tab, isCurrent && styles.current)} onClick={() => { if (!isCurrent) tabs.select(tab.id); }}>
        {tab.id === 'chats' ? <MessageCircle size={22} strokeWidth={ICON_STROKE} aria-hidden="true" /> : tab.id === 'browser' ? <BrowserIcon size={22} /> : tab.id === 'workspace' ? <LayoutGrid size={22} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Settings2 size={22} strokeWidth={ICON_STROKE} aria-hidden="true" />}
        <span>{tab.label}</span>
      </button>;
    })}
  </nav>;
}

const styles = stylex.create({
  bar: { position: 'fixed', left: 'max(16px, env(safe-area-inset-left))', right: 'max(16px, env(safe-area-inset-right))', bottom: 'max(12px, env(safe-area-inset-bottom))', zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-around', height: 64, padding: '0 6px', borderRadius: 32, backgroundColor: tokens.glass, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.glassBorder, backdropFilter: 'blur(22px) saturate(180%)', WebkitBackdropFilter: 'blur(22px) saturate(180%)', boxShadow: '0 8px 30px rgb(0 0 0 / .12)' },
  tab: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, height: 54, minWidth: 44, borderWidth: 0, borderRadius: 27, padding: 0, backgroundColor: 'transparent', color: tokens.muted, fontFamily: tokens.font, fontSize: '.6875rem', fontWeight: 600 },
  current: { color: tokens.primary, backgroundColor: 'color-mix(in srgb, var(--primary) 12%, transparent)' },
});
