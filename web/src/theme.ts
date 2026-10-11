import { THEME_PRESETS } from './theme-presets.ts';
export { THEME_PRESETS } from './theme-presets.ts';
export type Theme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'asideTheme';
export const TEXT_SIZE_STORAGE_KEY = 'asideTextSize';
export const TEXT_SIZES = [100, 125, 150, 175, 200];

export function loadTextSize() {
  try { const size = Number(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)); return TEXT_SIZES.includes(size) ? size : TEXT_SIZES[0]; }
  catch { return TEXT_SIZES[0]; }
}

export function applyTextSize(size: number) {
  document.documentElement.style.setProperty('--text-size', size + '%');
}

export function loadTheme(): Theme {
  return resolveTheme(loadThemeMode());
}

export function applyTheme(theme: Theme, appearance = loadAppearance()) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  applyAppearance(theme, appearance);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--canvas').trim());
}

export type ThemeMode = Theme | 'system';
export const APPEARANCE_STORAGE_KEY = 'asideRelayAppearance';
export const DEFAULT_ACCENT = '#a34dff';
export const ACCENT_COLORS = [DEFAULT_ACCENT, '#3a83f7', '#00a240', '#f0b429', '#f97316', '#ef476f', '#00a6a6', '#888888'];
export const UI_FONTS = [
  { id: 'wanted-sans', name: 'Wanted Sans', family: '"Wanted Sans Variable", "Wanted Sans", sans-serif' },
  { id: 'system', name: 'System', family: 'system-ui, -apple-system, sans-serif' },
  { id: 'inter', name: 'Inter', family: '"Inter", sans-serif' },
  { id: 'geist', name: 'Geist', family: '"Geist", sans-serif' },
  { id: 'noto-sans-kr', name: 'Noto Sans KR', family: '"Noto Sans KR", sans-serif' },
  { id: 'ibm-plex-sans', name: 'IBM Plex Sans', family: '"IBM Plex Sans", sans-serif' },
  { id: 'noto-serif-kr', name: 'Noto Serif KR', family: '"Noto Serif KR", serif' },
] as const;
export const CODE_FONTS = [
  { id: 'd2coding', name: 'D2Coding', family: '"D2Coding", monospace' },
  { id: 'system-mono', name: 'System Mono', family: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace' },
  { id: 'jetbrains-mono', name: 'JetBrains Mono', family: '"JetBrains Mono", monospace' },
  { id: 'fira-code', name: 'Fira Code', family: '"Fira Code", monospace' },
  { id: 'geist-mono', name: 'Geist Mono', family: '"Geist Mono", monospace' },
] as const;
export type Appearance = {
  lightPreset: string; darkPreset: string; accent: string;
  uiFont: string; contentFont: string; codeFont: string;
};
const DEFAULT_APPEARANCE: Appearance = { lightPreset: 'relay', darkPreset: 'relay', accent: '', uiFont: 'wanted-sans', contentFont: 'wanted-sans', codeFont: 'd2coding' };

export function loadThemeMode(): ThemeMode {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'dark' || value === 'system' ? value : 'light';
  } catch { return 'light'; }
}

export function resolveTheme(mode: ThemeMode): Theme {
  return mode === 'system' ? window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : mode;
}

export function loadAppearance(): Appearance {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object') return { ...DEFAULT_APPEARANCE };
    const preset = (key: 'lightPreset' | 'darkPreset', scheme: Theme) => THEME_PRESETS.some(item => item.id === Reflect.get(value, key) && item.scheme === scheme) ? String(Reflect.get(value, key)) : 'relay';
    const font = (key: 'uiFont' | 'contentFont' | 'codeFont', choices: readonly { id: string }[]) => choices.some(item => item.id === Reflect.get(value, key)) ? String(Reflect.get(value, key)) : DEFAULT_APPEARANCE[key];
    const accent = Reflect.get(value, 'accent');
    return { lightPreset: preset('lightPreset', 'light'), darkPreset: preset('darkPreset', 'dark'), accent: typeof accent === 'string' && /^#[\da-f]{6}$/i.test(accent) ? accent : '', uiFont: font('uiFont', UI_FONTS), contentFont: font('contentFont', UI_FONTS), codeFont: font('codeFont', CODE_FONTS) };
  } catch { return { ...DEFAULT_APPEARANCE }; }
}

export function contrastForeground(color: string) {
  const channels = [1, 3, 5].map(offset => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  return (luminance + .05) / .05 > 1.05 / (luminance + .05) ? '#000000' : '#ffffff';
}

function applyAppearance(theme: Theme, appearance: Appearance) {
  const root = document.documentElement;
  const preset = THEME_PRESETS.find(item => item.id === (theme === 'light' ? appearance.lightPreset : appearance.darkPreset) && item.scheme === theme);
  const values: Record<string, string> = preset ? {
    '--canvas': preset.background, '--text': preset.foreground,
    '--surface': 'color-mix(in srgb, var(--canvas) 94%, var(--text))',
    '--bubble': 'color-mix(in srgb, var(--canvas) 90%, var(--text))',
    '--muted': 'color-mix(in srgb, var(--canvas) 38%, var(--text))',
    '--border': 'color-mix(in srgb, var(--canvas) 82%, var(--text))',
    '--hover': 'color-mix(in srgb, var(--canvas) 86%, var(--text))',
    '--control-border': 'var(--border)', '--glass': 'color-mix(in srgb, var(--surface) 85%, transparent)',
  } : {};
  for (const key of ['--canvas', '--text', '--surface', '--bubble', '--muted', '--border', '--hover', '--control-border', '--glass']) root.style.removeProperty(key);
  const accent = appearance.accent || preset?.accent || DEFAULT_ACCENT;
  values['--primary'] = accent;
  values['--primary-foreground'] = contrastForeground(accent);
  values['--font-sans'] = (UI_FONTS.find(font => font.id === appearance.uiFont) ?? UI_FONTS[0]).family;
  values['--font-content'] = (UI_FONTS.find(font => font.id === appearance.contentFont) ?? UI_FONTS[0]).family;
  values['--font-code'] = (CODE_FONTS.find(font => font.id === appearance.codeFont) ?? CODE_FONTS[0]).family;
  Object.entries(values).forEach(([name, value]) => root.style.setProperty(name, value));
  const fontIds = [...new Set([appearance.uiFont, appearance.contentFont, appearance.codeFont])].filter(id => !['system', 'system-mono', 'd2coding'].includes(id));
  root.dataset.fontStylesheets = JSON.stringify(fontIds.map(id => '/api/font/css/' + id));
  for (const id of fontIds) {
    if (document.querySelector(`link[data-appearance-font="${id}"]`)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/api/font/css/' + id; link.dataset.appearanceFont = id;
    document.head.append(link);
  }
}
