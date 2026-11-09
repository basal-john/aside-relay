const FADE_FALLBACK_MS = 600;

/**
 * Fades out the launch layer from index.html once React has put its first frame on screen.
 * The layer repeats the iOS launch image, so the hand-off from the launch screen to the app shows no flash.
 */
export function dismissBootScreen(doc: Document = document) {
  const boot = doc.getElementById('boot');
  const root = doc.getElementById('root');
  if (!boot) return;
  const remove = () => boot.remove();
  const fade = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { remove(); return; }
    boot.addEventListener('transitionend', remove, { once: true });
    boot.classList.add('boot-out');
    setTimeout(remove, FADE_FALLBACK_MS);
  }));
  if (!root || root.childElementCount > 0) { fade(); return; }
  const observer = new MutationObserver(() => {
    if (root.childElementCount === 0) return;
    observer.disconnect();
    fade();
  });
  observer.observe(root, { childList: true });
}
