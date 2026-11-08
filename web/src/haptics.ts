/**
 * Haptic feedback for taps on buttons, links and menu actions.
 *
 * Ported from the bb haptics plugin (~/.bb-plugins-dev/bb-plugin-haptics, commit 565f923), whose
 * iOS behaviour was measured on Basal's iPhone.
 *
 * iOS: Safari has no Vibration API. It plays the system tick only when a real tap toggles an
 * `<input type="checkbox" switch>`. Programmatic clicks do not buzz. Every leaf control gets a
 * transparent `<label>` for one hidden page-wide switch, so a tap on the control is also a trusted
 * tap on the switch. The tap still bubbles to the control as a normal click.
 * - iOS sends no click at all after a cancelled pointerdown. The page's pointerdown preventDefault is
 *   recorded instead of applied, and the mousedown and mouseup that follow are cancelled and stopped,
 *   so focus and the keyboard stay where the page wanted them.
 * - WebKit skips native link navigation for a tap on the overlay, so plain links are followed through
 *   a detached anchor unless the page cancelled the click.
 * - A control counts as disabled only if it was disabled when the finger went down.
 * - `<summary>` gets no overlay: a tap on the label does not open its `<details>`.
 * - iOS drops the click when the tapped control is removed, or clickable content appears, before the
 *   click. Controls that change the page on pointerdown lose the haptic but keep working.
 *
 * Android and other browsers with the Vibration API get a short pulse on touch taps of controls.
 */

export const HAPTICS_STORAGE_KEY = 'aside-relay.haptics';
export const HAPTIC_TRIGGER_ATTRIBUTE = 'data-haptic-trigger';
const SWITCH_ID = 'aside-relay-haptics-switch';
const POSITIONED_ATTRIBUTE = 'data-haptic-positioned';
const SCAN_DELAY_MS = 200;
const ANDROID_PULSE_MS = 10;

const TARGETS = [
  'button', 'a[href]', '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]', '[role="tab"]', '[role="option"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]',
].join(',');
const NESTED_CONTROLS = `${TARGETS},input,textarea,select,label,[contenteditable]:not([contenteditable="false"])`;
const PROXIED_ANCHOR_ATTRIBUTES = ['href', 'target', 'rel', 'download', 'referrerpolicy', 'hreflang', 'type', 'ping'];

interface Pressed { label: HTMLLabelElement; enabled: boolean; downPrevented: boolean }
interface PendingTap { label: HTMLLabelElement; prevented: boolean }

let controller: AbortController | undefined;

/** Reads the saved preference. Haptics are on unless the user turned them off. */
export function loadHaptics(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage) {
  try { return storage?.getItem(HAPTICS_STORAGE_KEY) !== 'off'; } catch { return true; }
}

/** Saves the preference and starts or stops haptics to match. */
export function setHaptics(isEnabled: boolean) {
  try { localStorage.setItem(HAPTICS_STORAGE_KEY, isEnabled ? 'on' : 'off'); } catch { /* storage blocked */ }
  if (isEnabled) startHaptics(); else stopHaptics();
}

/** True on iPhone, iPod and iPad (iPadOS reports itself as MacIntel with touch points). */
export function isIos(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator) {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

/** Whether this device can produce a tap haptic. */
export function supportsHaptics() {
  return typeof window !== 'undefined' && (isIos() || (typeof navigator.vibrate === 'function' && matchMedia('(pointer: coarse)').matches));
}

/** True when an event landed on a haptic overlay, so the page will get a real click for it. */
export function isHapticTrigger(target: EventTarget | null): target is HTMLLabelElement {
  return target instanceof HTMLLabelElement && target.hasAttribute(HAPTIC_TRIGGER_ATTRIBUTE);
}

/** Starts haptics when the device supports them and the user has not turned them off. */
export function startHaptics() {
  if (controller || !supportsHaptics() || !loadHaptics()) return;
  controller = new AbortController();
  if (isIos()) installIos(controller.signal); else installVibrate(controller.signal);
}

/** Stops haptics and removes every overlay. */
export function stopHaptics() {
  controller?.abort();
  controller = undefined;
}

function isDisabled(element: Element) {
  return element.matches(':disabled, [aria-disabled="true"]') || element.closest('fieldset:disabled') !== null;
}

/** Controls that hold other controls, sit inside a label or an editor, or are disabled get no overlay. */
function wantsOverlay(element: HTMLElement) {
  if (element.id === SWITCH_ID || element.isContentEditable || isDisabled(element)) return false;
  if (element.parentElement?.closest('label') || element.closest('[contenteditable]:not([contenteditable="false"])')) return false;
  for (const inner of element.querySelectorAll(NESTED_CONTROLS)) if (!isHapticTrigger(inner)) return false;
  return true;
}

function ownLabel(element: HTMLElement) {
  const last = element.lastElementChild;
  if (isHapticTrigger(last)) return last;
  return element.querySelector<HTMLLabelElement>(`:scope > label[${HAPTIC_TRIGGER_ATTRIBUTE}]`);
}

function attach(element: HTMLElement) {
  const label = document.createElement('label');
  label.htmlFor = SWITCH_ID;
  label.setAttribute(HAPTIC_TRIGGER_ATTRIBUTE, '');
  label.setAttribute('aria-hidden', 'true');
  if (getComputedStyle(element).position === 'static') {
    element.style.position = 'relative';
    element.setAttribute(POSITIONED_ATTRIBUTE, '');
  }
  element.append(label);
}

function detach(element: HTMLElement, label: HTMLLabelElement) {
  label.remove();
  if (element.hasAttribute(POSITIONED_ATTRIBUTE)) {
    element.style.position = '';
    element.removeAttribute(POSITIONED_ATTRIBUTE);
  }
}

function followLink(label: HTMLLabelElement) {
  for (let element = label.parentElement; element; element = element.parentElement) {
    if (element instanceof HTMLButtonElement && element.form && (element.type === 'submit' || element.type === 'reset')) return;
    if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) {
      const proxy = document.createElement('a');
      for (const name of PROXIED_ANCHOR_ATTRIBUTES) {
        const value = element.getAttribute(name);
        if (value !== null) proxy.setAttribute(name, value);
      }
      proxy.click();
      return;
    }
  }
}

function recordPreventDefault(event: Event, onPrevent: () => void, isPrevented: () => boolean) {
  Object.defineProperties(event, {
    preventDefault: { configurable: true, value: () => { if (event.cancelable) onPrevent(); } },
    defaultPrevented: { configurable: true, get: isPrevented },
    returnValue: { configurable: true, get: () => !isPrevented(), set: (value: boolean) => { if (!value && event.cancelable) onPrevent(); } },
  });
}

function installIos(signal: AbortSignal) {
  let pendingTap: PendingTap | undefined;
  let pressed: Pressed | undefined;

  const onPointerDown = (event: PointerEvent) => {
    const label = isHapticTrigger(event.target) ? event.target : null;
    const control = label?.parentElement;
    if (!label || !control) { pressed = undefined; return; }
    const press: Pressed = { label, enabled: !isDisabled(control), downPrevented: false };
    pressed = press;
    if (press.enabled) recordPreventDefault(event, () => { press.downPrevented = true; }, () => press.downPrevented);
  };

  const onMouse = (event: MouseEvent) => {
    if (!pressed?.downPrevented || event.target !== pressed.label) return;
    event.stopImmediatePropagation();
    if (event.type === 'mousedown') event.preventDefault();
  };

  const switchEl = document.createElement('input');
  switchEl.type = 'checkbox';
  switchEl.setAttribute('switch', '');
  switchEl.id = SWITCH_ID;
  switchEl.tabIndex = -1;
  switchEl.setAttribute('aria-hidden', 'true');
  document.body.append(switchEl);

  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (target === switchEl) {
      event.stopImmediatePropagation();
      if (pendingTap && !pendingTap.prevented) followLink(pendingTap.label);
      return;
    }
    if (!isHapticTrigger(target)) return;
    const control = target.parentElement;
    const press = pressed?.label === target ? pressed : undefined;
    const enabledAtDown = press ? press.enabled : !(control && isDisabled(control));
    pressed = undefined;
    if (!enabledAtDown) { event.preventDefault(); return; }
    const tap: PendingTap = { label: target, prevented: false };
    pendingTap = tap;
    recordPreventDefault(event, () => { tap.prevented = true; }, () => tap.prevented);
  };

  const onActivate = (event: Event) => {
    const tap = pendingTap;
    if (!tap || event.target !== tap.label) return;
    pendingTap = undefined;
    if (tap.prevented) { event.stopImmediatePropagation(); event.preventDefault(); }
  };

  const scan = () => {
    for (const element of document.querySelectorAll<HTMLElement>(TARGETS)) {
      const label = ownLabel(element);
      const wanted = wantsOverlay(element);
      if (wanted && !label) attach(element);
      else if (!wanted && label) detach(element, label);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleScan = () => {
    if (timer !== undefined || signal.aborted) return;
    timer = setTimeout(() => { timer = undefined; if (!signal.aborted) scan(); }, SCAN_DELAY_MS);
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) if (!isHapticTrigger(node)) return scheduleScan();
      for (const node of record.removedNodes) if (!isHapticTrigger(node)) return scheduleScan();
      if (record.type === 'attributes') return scheduleScan();
    }
  });

  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  window.addEventListener('mousedown', onMouse, true);
  window.addEventListener('mouseup', onMouse, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('DOMActivate', onActivate, true);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'href', 'contenteditable', 'disabled', 'aria-disabled'] });
  scan();

  signal.addEventListener('abort', () => {
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('mousedown', onMouse, true);
    window.removeEventListener('mouseup', onMouse, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('DOMActivate', onActivate, true);
    for (const label of document.querySelectorAll<HTMLLabelElement>(`label[${HAPTIC_TRIGGER_ATTRIBUTE}]`)) {
      if (label.parentElement) detach(label.parentElement, label); else label.remove();
    }
    switchEl.remove();
  }, { once: true });
}

function installVibrate(signal: AbortSignal) {
  let lastPointerType = '';
  const onPointerDown = (event: PointerEvent) => { lastPointerType = event.pointerType; };
  const onClick = (event: MouseEvent) => {
    if (lastPointerType !== 'touch' || !event.isTrusted) return;
    const target = event.target instanceof Element ? event.target.closest(TARGETS) : null;
    if (target && !isDisabled(target)) navigator.vibrate(ANDROID_PULSE_MS);
  };
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  window.addEventListener('click', onClick, { capture: true, passive: true });
  signal.addEventListener('abort', () => {
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('click', onClick, true);
  }, { once: true });
}
