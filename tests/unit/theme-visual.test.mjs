import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  APPEARANCE_STORAGE_KEY, THEME_PRESETS, contrastForeground, loadAppearance, resolveTheme,
  TEXT_SIZE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyTextSize,
  applyTheme,
  loadTextSize,
  loadTheme,
} from '../../web/src/theme.ts'
import { VISUAL_MESSAGE_PREFIX, visualDocument, visualTheme } from '../../web/src/visual.ts'

test('visual font metadata rejects malformed values and only loads local font stylesheets', () => {
  const environment = installDom()
  try {
    for (const value of ['{', '{}', '"bad"', JSON.stringify(['/api/font/css/wanted-sans', 'https://example.test/unsafe.css', 123])]) {
      document.documentElement.dataset.fontStylesheets = value
      const theme = visualTheme()
      assert.ok(Array.isArray(theme.fontStylesheets))
      assert.ok(theme.fontStylesheets.every(path => /^\/api\/font\/css\/[a-z-]+$/.test(path)))
      const documentHtml = visualDocument('<p>Preview survives invalid font metadata.</p>', 'font-regression')
      assert.ok(documentHtml.includes('Preview survives invalid font metadata.'))
      assert.ok(!documentHtml.includes('unsafe.css'))
    }
  } finally {
    environment.restore()
  }
})

function installDom(html = '<!doctype html><html><head><meta name="color-scheme"><meta name="theme-color"></head><body></body></html>', url = 'https://aside.test/') {
  const dom = new JSDOM(html, { url })
  const previous = new Map()
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    DOMParser: dom.window.DOMParser,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    location: dom.window.location,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  return {
    dom,
    restore() {
      dom.window.close()
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
    },
  }
}

test('theme and text-size storage use safe defaults and retain supported choices', () => {
  const environment = installDom()
  try {
    assert.equal(loadTheme(), 'light')
    assert.equal(loadTextSize(), 100)

    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, '175')
    assert.equal(loadTheme(), 'dark')
    assert.equal(loadTextSize(), 175)

    localStorage.setItem(THEME_STORAGE_KEY, 'system')
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, '999')
    assert.equal(loadTheme(), 'light')
    assert.equal(loadTextSize(), 100)
  } finally {
    environment.restore()
  }
})

test('applying a theme updates both the page palette and iOS status-bar metadata', () => {
  const environment = installDom()
  try {
    document.head.insertAdjacentHTML('beforeend', '<style>html[data-theme="dark"] { --canvas: #050505; }</style>')
    applyTheme('dark')
    applyTextSize(150)

    assert.equal(document.documentElement.dataset.theme, 'dark')
    assert.equal(document.querySelector('meta[name="color-scheme"]').content, 'dark')
    assert.equal(document.querySelector('meta[name="theme-color"]').content, '#050505')
    assert.equal(document.documentElement.style.getPropertyValue('--text-size'), '150%')
  } finally {
    environment.restore()
  }
})

test('visual theme exports the active app colors and dark-mode chart contrast', () => {
  const environment = installDom()
  try {
    const root = document.documentElement
    root.dataset.theme = 'dark'
    for (const [name, value] of Object.entries({ '--canvas': '#050505', '--text': '#f7f7f7', '--muted': '#999', '--border': '#333', '--surface': '#111', '--bubble': '#222', '--primary': '#a33cff', '--primary-foreground': '#fff', '--danger': '#f66' })) {
      root.style.setProperty(name, value)
    }

    const theme = visualTheme()
    assert.equal(theme.scheme, 'dark')
    assert.equal(theme.variables['--background'], '#050505')
    assert.equal(theme.variables['--primary'], '#a33cff')
    assert.equal(theme.variables['--chart-2'], '#a7d6a7')
  } finally {
    environment.restore()
  }
})

test('visual documents remove inherited navigation/security metadata and install a restrictive policy', () => {
  const environment = installDom()
  try {
    const output = visualDocument('<html><head><base href="https://attacker.test/"><meta http-equiv="refresh" content="0;url=https://attacker.test"><style>.grid{grid-template-columns:repeat(5,minmax(12px,1fr))}</style></head><body><div class="grid">LongWord</div></body></html>', 'visual-1')
    const rendered = new JSDOM(output).window.document
    const policy = rendered.querySelector('meta[http-equiv="Content-Security-Policy"]')
    const styles = [...rendered.querySelectorAll('style')].map(node => node.textContent).join('\n')

    assert.equal(rendered.querySelector('base'), null)
    assert.equal(rendered.querySelector('meta[http-equiv="refresh"]'), null)
    assert.match(policy.content, /default-src 'none'/)
    assert.match(policy.content, /connect-src 'none'/)
    assert.match(policy.content, /frame-src 'none'/)
    assert.match(policy.content, /form-action 'none'/)
    assert.match(styles, /minmax\(min\(12px, 100%\), 1fr\)/)
    assert.match(styles, /overflow-wrap:anywhere/)
    assert.match(styles, /overflow-x:hidden/)
    assert.equal(rendered.querySelector('meta[name="viewport"]').content, 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
  } finally {
    environment.restore()
  }
})

test('visual documents announce readiness and only accept matching parent theme messages', async () => {
  const environment = installDom()
  let output
  try {
    output = visualDocument('<html><head></head><body><main>Preview</main></body></html>', 'visual-42')
  } finally {
    environment.restore()
  }

  const posted = []
  const rendered = new JSDOM(output, {
    runScripts: 'dangerously',
    url: 'https://aside.test/preview',
    beforeParse(window) {
      window.postMessage = (message, target) => posted.push({ message, target })
    },
  })
  try {
    await new Promise(resolve => rendered.window.setTimeout(resolve, 0))
    assert.equal(posted.length, 1)
    assert.equal(posted[0].message.type, `${VISUAL_MESSAGE_PREFIX}ready`)
    assert.equal(posted[0].message.id, 'visual-42')
    assert.equal(posted[0].target, '*')

    const root = rendered.window.document.documentElement
    const unrelated = new JSDOM('').window
    rendered.window.dispatchEvent(new rendered.window.MessageEvent('message', {
      source: unrelated,
      data: { type: `${VISUAL_MESSAGE_PREFIX}theme`, id: 'visual-42', scheme: 'dark', variables: { '--background': '#222' } },
    }))
    unrelated.close()
    assert.notEqual(root.style.getPropertyValue('--background'), '#222')

    rendered.window.dispatchEvent(new rendered.window.MessageEvent('message', {
      source: rendered.window,
      data: { type: `${VISUAL_MESSAGE_PREFIX}theme`, id: 'other', scheme: 'dark', variables: { '--background': '#111' } },
    }))
    assert.notEqual(root.style.getPropertyValue('--background'), '#111')

    rendered.window.dispatchEvent(new rendered.window.MessageEvent('message', {
      source: rendered.window,
      data: { type: `${VISUAL_MESSAGE_PREFIX}theme`, id: 'visual-42', scheme: 'dark', variables: { '--background': '#111', '--foreground': '#eee' } },
    }))
    assert.equal(root.style.getPropertyValue('--background'), '#111')
    assert.equal(root.style.getPropertyValue('--foreground'), '#eee')
    assert.equal(root.style.colorScheme, 'dark')
  } finally {
    rendered.window.close()
  }
})


test('appearance validates every stored choice and rejects CSS injection', () => {
  const environment = installDom();
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ lightPreset: 'dracula-dark', darkPreset: 'dracula-dark', accent: 'url(https://unsafe.test)', uiFont: 'unknown', contentFont: 'noto-serif-kr', codeFont: 'jetbrains-mono' }));
    assert.deepEqual(loadAppearance(), { lightPreset: 'relay', darkPreset: 'dracula-dark', accent: '', uiFont: 'wanted-sans', contentFont: 'noto-serif-kr', codeFont: 'jetbrains-mono' });
    localStorage.setItem(APPEARANCE_STORAGE_KEY, '{');
    assert.equal(loadAppearance().darkPreset, 'relay');
  } finally { environment.restore(); }
});

test('all 29 preset families apply their palette and restore default without leaking colors', () => {
  const environment = installDom();
  try {
    assert.equal(new Set(THEME_PRESETS.map(preset => preset.name)).size, 29);
    for (const preset of THEME_PRESETS) {
      const appearance = { ...loadAppearance(), [preset.scheme === 'light' ? 'lightPreset' : 'darkPreset']: preset.id };
      applyTheme(preset.scheme, appearance);
      assert.equal(document.documentElement.style.getPropertyValue('--canvas'), preset.background);
      assert.equal(document.querySelector('meta[name="theme-color"]').content, preset.background);
      assert.equal(document.documentElement.style.getPropertyValue('--primary'), preset.accent);
    }
    applyTheme('light', loadAppearance());
    assert.equal(document.documentElement.style.getPropertyValue('--canvas'), '');
    assert.equal(document.documentElement.style.getPropertyValue('--primary'), '#a34dff');
  } finally { environment.restore(); }
});

test('custom accent, independent fonts and visuals share settings; font links are deduplicated', () => {
  const environment = installDom();
  try {
    const appearance = { ...loadAppearance(), accent: '#f0b429', uiFont: 'inter', contentFont: 'noto-serif-kr', codeFont: 'fira-code' };
    applyTheme('dark', appearance);
    applyTheme('dark', appearance);
    assert.equal(document.documentElement.style.getPropertyValue('--primary-foreground'), '#000000');
    assert.match(visualTheme().variables['--font-sans'], /Noto Serif KR/);
    assert.equal(document.querySelectorAll('link[data-appearance-font]').length, 3);
    assert.equal(contrastForeground('#000000'), '#ffffff');
    assert.equal(contrastForeground('#ffffff'), '#000000');
    window.matchMedia = () => ({ matches: true });
    assert.equal(resolveTheme('system'), 'dark');
    window.matchMedia = () => ({ matches: false });
    assert.equal(resolveTheme('system'), 'light');
  } finally { environment.restore(); }
});
