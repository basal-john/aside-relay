const FADE_FALLBACK_MS = 600;
const MIN_VISIBLE_MS = 1400;

/**
 * Fades out the launch layer from index.html once React has put its first frame on screen.
 * The layer repeats the iOS launch image, so the hand-off from the launch screen to the app shows no flash.
 * It stays for at least MIN_VISIBLE_MS after navigation start, one full period of the dot ripple.
 * Reduce Motion removes it as soon as the app has rendered.
 */
export function dismissBootScreen(doc: Document = document) {
  const boot = doc.getElementById('boot');
  const root = doc.getElementById('root');
  if (!boot) return;
  const remove = () => boot.remove();
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const fadeNow = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (reducedMotion()) { remove(); return; }
    boot.addEventListener('transitionend', remove, { once: true });
    boot.classList.add('boot-out');
    setTimeout(remove, FADE_FALLBACK_MS);
  }));
  const fade = () => {
    const wait = reducedMotion() ? 0 : Math.max(0, MIN_VISIBLE_MS - performance.now());
    if (wait > 0) setTimeout(fadeNow, wait);
    else fadeNow();
  };
  if (!root || root.childElementCount > 0) { fade(); return; }
  const observer = new MutationObserver(() => {
    if (root.childElementCount === 0) return;
    observer.disconnect();
    fade();
  });
  observer.observe(root, { childList: true });
}
