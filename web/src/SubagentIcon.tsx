import { useId } from 'react';

export type SubagentColor = 'orange' | 'yellow' | 'green' | 'sky' | 'indigo' | 'violet' | 'pink' | 'red';

const colors: SubagentColor[] = ['orange', 'yellow', 'green', 'sky', 'indigo', 'violet', 'pink', 'red'];
const gradients: Record<SubagentColor, { light: string; dark: string; end: string }> = {
  orange: { light: 'oklch(75% 0.183 55.934)', dark: 'oklch(83.7% 0.128 66.29)', end: 'oklch(64.6% 0.222 41.116)' },
  yellow: { light: 'oklch(85.2% 0.199 91.936)', dark: 'oklch(90.5% 0.182 98.111)', end: 'oklch(68.1% 0.162 75.834)' },
  green: { light: 'oklch(79.2% 0.209 151.711)', dark: 'oklch(87.1% 0.15 154.449)', end: 'oklch(62.7% 0.194 149.214)' },
  sky: { light: 'oklch(74.6% 0.16 232.661)', dark: 'oklch(82.8% 0.111 230.318)', end: 'oklch(58.8% 0.158 241.966)' },
  indigo: { light: 'oklch(67.3% 0.182 276.935)', dark: 'oklch(78.5% 0.115 274.713)', end: 'oklch(51.1% 0.262 276.966)' },
  violet: { light: 'oklch(70.2% 0.183 293.541)', dark: 'oklch(81.1% 0.111 293.571)', end: 'oklch(54.1% 0.281 293.009)' },
  pink: { light: 'oklch(71.8% 0.202 349.761)', dark: 'oklch(82.3% 0.12 346.018)', end: 'oklch(59.2% 0.249 0.584)' },
  red: { light: 'oklch(70.4% 0.191 22.216)', dark: 'oklch(80.8% 0.114 19.571)', end: 'oklch(57.7% 0.245 27.325)' },
};

export function subagentColors(sessionIds: string[]) {
  const used = new Set<SubagentColor>();
  return new Map(sessionIds.map(sessionId => {
    const initial = hashColor(sessionId);
    const color = colors.map((_, offset) => colors[(initial + offset) % colors.length]).find(candidate => !used.has(candidate)) ?? colors[initial];
    used.add(color);
    return [sessionId, color];
  }));
}

export function SubagentIcon({ sessionId, color, size = 18 }: { sessionId: string; color?: SubagentColor; size?: number }) {
  const id = useId().replaceAll(':', '');
  const selected = color ?? colors[hashColor(sessionId)];
  const gradient = gradients[selected];
  const lightId = `subagent-light-${id}`;
  const darkId = `subagent-dark-${id}`;
  const pathClass = `subagent-icon-${id}`;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={lightId} x2="1" y2="1"><stop stopColor={gradient.light} /><stop offset="1" stopColor={gradient.end} /></linearGradient>
      <linearGradient id={darkId} x2="1" y2="1"><stop stopColor={gradient.dark} /><stop offset="1" stopColor={gradient.end} /></linearGradient>
    </defs>
    <path fill={`url(#${lightId})`} className={pathClass} d="M6.90986 2.73871C9.80058 0.968848 13.9716 1.35518 17.1472 3.77582C22.8616 7.73363 23.2313 15.547 21.8425 19.0659C20.1912 23.2491 4.78915 23.4773 2.53779 19.5766C0.541459 16.1174 1.50912 11.74 4.26728 9.37543C3.69303 6.96606 4.60628 4.06868 6.90986 2.73871ZM11.7224 7.57954C10.9172 7.57956 10.2644 8.23242 10.2643 9.03754V11.7768C10.2644 12.5819 10.9172 13.2348 11.7224 13.2348H11.8669C12.672 13.2348 13.3249 12.582 13.3249 11.7768V9.03754C13.3248 8.2324 12.672 7.57954 11.8669 7.57954H11.7224ZM16.9958 7.67914C16.2455 7.67926 15.6374 8.2872 15.6374 9.03754V11.7836C15.6374 12.534 16.2455 13.1419 16.9958 13.142C17.7462 13.142 18.3551 12.5341 18.3552 11.7836V9.03754C18.3551 8.28713 17.7462 7.67914 16.9958 7.67914Z" />
    <style>{`html[data-theme="dark"] .${pathClass}{fill:url(#${darkId})}`}</style>
  </svg>;
}

function hashColor(sessionId: string) {
  return [...sessionId].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0) % colors.length;
}
