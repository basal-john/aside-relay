import { useEffect, useState } from 'react';

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferredPrompt: InstallPromptEvent | undefined;
const listeners = new Set<() => void>();

/** Registers the offline service worker and keeps the browser's install prompt for the Install app button. */
export function startInstallSupport() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => { }); }, { once: true });
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    listeners.forEach(listener => listener());
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = undefined; listeners.forEach(listener => listener()); });
}

export function isInstalled() {
  return Boolean(Reflect.get(navigator, 'standalone')) || !!window.matchMedia?.('(display-mode: standalone)').matches;
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Returns how this device can install the app: a native prompt, the iOS Share sheet, or nothing. */
export function useInstallOption(): { kind: 'prompt'; install: () => Promise<void> } | { kind: 'ios' } | undefined {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion(value => value + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  if (isInstalled()) return undefined;
  if (deferredPrompt) {
    const prompt = deferredPrompt;
    return { kind: 'prompt', install: async () => { await prompt.prompt(); await prompt.userChoice; deferredPrompt = undefined; listeners.forEach(listener => listener()); } };
  }
  if (isIOS()) return { kind: 'ios' };
  return undefined;
}
