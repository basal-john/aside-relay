import { useEffect, useEffectEvent, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { browserScrollDelta, getBrowserKey, type BrowserControl } from './browser';

export type BrowserControlHandler = (payload: BrowserControl) => Promise<boolean>;

const SCROLL_THRESHOLD = 10;
const DRAG_SCROLL_SCALE = 3;
const WHEEL_LINE_HEIGHT = 16;

export function useBrowserInput<T extends HTMLElement>({ onControl }: { onControl?: BrowserControlHandler }) {
  const ref = useRef<T>(null);
  const pointersRef = useRef<number[]>([]);
  const gestureRef = useRef<{ id: number; x: number; y: number; point: { x: number; y: number } } | undefined>(undefined);
  const isEnabled = !!onControl;
  const sendWheel = useEffectEvent((payload: BrowserControl) => { void onControl?.(payload); });

  useEffect(() => {
    const surface = ref.current;
    if (!surface || !isEnabled) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const point = normalizedPoint(surface, event.clientX, event.clientY);
      if (!point) return;
      const unit = event.deltaMode === 1 ? WHEEL_LINE_HEIGHT : event.deltaMode === 2 ? surface.clientHeight : 1;
      sendWheel({ action: 'scroll', ...point, deltaX: browserScrollDelta(event.deltaX * unit), deltaY: browserScrollDelta(event.deltaY * unit) });
    };
    function stopTouch(event: TouchEvent) {
      event.stopPropagation();
      if (event.type === 'touchmove' && event.cancelable) event.preventDefault();
    }
    surface.addEventListener('wheel', wheel, { passive: false });
    surface.addEventListener('touchstart', stopTouch, { passive: true });
    surface.addEventListener('touchmove', stopTouch, { passive: false });
    surface.addEventListener('touchend', stopTouch);
    surface.addEventListener('touchcancel', stopTouch);
    return () => {
      surface.removeEventListener('wheel', wheel);
      surface.removeEventListener('touchstart', stopTouch);
      surface.removeEventListener('touchmove', stopTouch);
      surface.removeEventListener('touchend', stopTouch);
      surface.removeEventListener('touchcancel', stopTouch);
      pointersRef.current = [];
      gestureRef.current = undefined;
    };
  }, [isEnabled]);

  return { ref, onPointerDown, onPointerUp, onPointerCancel, onLostPointerCapture: onPointerCancel, onKeyDown };

  function onPointerDown(event: PointerEvent<T>) {
    if (!onControl || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.push(event.pointerId);
    const point = normalizedPoint(event.currentTarget, event.clientX, event.clientY);
    gestureRef.current = pointersRef.current.length === 1 && point
      ? { id: event.pointerId, x: event.clientX, y: event.clientY, point }
      : undefined;
  }

  function onPointerUp(event: PointerEvent<T>) {
    const gesture = gestureRef.current;
    onPointerCancel(event);
    if (!onControl || !gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.hypot(dx, dy) > SCROLL_THRESHOLD) {
      void onControl({ action: 'scroll', ...gesture.point, deltaX: browserScrollDelta(-dx * DRAG_SCROLL_SCALE), deltaY: browserScrollDelta(-dy * DRAG_SCROLL_SCALE) });
    } else {
      const point = normalizedPoint(event.currentTarget, event.clientX, event.clientY);
      if (point) void onControl({ action: 'click', ...point });
    }
  }

  function onPointerCancel(event: PointerEvent<T>) {
    pointersRef.current = pointersRef.current.filter(id => id !== event.pointerId);
    gestureRef.current = undefined;
  }

  function onKeyDown(event: KeyboardEvent<T>) {
    if (!onControl || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = getBrowserKey(event.key);
    if (!key && event.key.length !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    void onControl(key ? { action: 'key', key } : { action: 'type', text: event.key });
  }
}

function normalizedPoint(surface: HTMLElement, clientX: number, clientY: number) {
  const image = surface.querySelector('img');
  if (!image?.naturalWidth || !image.naturalHeight) return;
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const left = bounds.left + (bounds.width - width) / 2;
  const top = bounds.top + (bounds.height - height) / 2;
  if (!width || !height || clientX < left || clientX > left + width || clientY < top || clientY > top + height) return;
  return { x: (clientX - left) / width, y: (clientY - top) / height };
}
