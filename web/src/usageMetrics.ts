/** Pace, reset and budget helpers for the usage panel (same rules as bb's model-token-usage). */

export type UsageKind = 'five_hour' | 'weekly' | 'monthly';

export type UsageWindowMetric = {
  kind: UsageKind;
  label: string;
  usedPercent: number;
  resetsAt?: string;
};

const KIND_DURATION_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  'five-hour': 5 * 3_600_000,
  'five hour': 5 * 3_600_000,
  weekly: 7 * 24 * 3_600_000,
  monthly: 30 * 24 * 3_600_000,
};

const KIND_TITLE: Record<UsageKind, string> = {
  five_hour: '5-hour session',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const FAMILY_NAMES = ['sonnet', 'opus', 'haiku', 'fable', 'composer', 'grok', 'luna', 'sol', 'terra', 'astra', 'gpt'] as const;

export function windowTitle(kind: UsageKind) {
  return KIND_TITLE[kind] ?? kind;
}

export function shortModelLabel(modelId?: string, fallbackName?: string) {
  const source = modelId || fallbackName || '';
  if (!source) return 'Aside';
  const leaf = source.split('/').pop() ?? source;
  const cleaned = leaf.replace(/^claude[-_]?/i, '').replace(/^gpt[-_]?/i, '');
  const parts = cleaned.toLowerCase().split(/[-_.\s]+/).filter(Boolean);
  for (const part of parts) {
    if ((FAMILY_NAMES as readonly string[]).includes(part)) return part.charAt(0).toUpperCase() + part.slice(1);
  }
  if (fallbackName) {
    const word = fallbackName.split(/\s+/).find(item => /opus|sonnet|haiku|fable|luna|sol|terra|astra|gpt|grok/i.test(item));
    if (word) return word.replace(/[^a-zA-Z0-9.]/g, '');
  }
  return parts[0] ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) : leaf;
}

export function usageTone(used: number | null): 'ok' | 'warn' | 'bad' | 'none' {
  if (used == null) return 'none';
  if (used >= 85) return 'bad';
  if (used >= 60) return 'warn';
  return 'ok';
}

export function elapsedPercent(window: UsageWindowMetric, now = new Date()): number | null {
  if (!window.resetsAt) return null;
  const duration = KIND_DURATION_MS[window.kind];
  if (!duration) return null;
  const resetsAt = new Date(window.resetsAt).getTime();
  if (Number.isNaN(resetsAt)) return null;
  const left = resetsAt - now.getTime();
  return Math.min(100, Math.max(0, (1 - left / duration) * 100));
}

export function paceLabel(used: number | null, elapsed: number | null): string | null {
  if (used == null || elapsed == null) return null;
  const diff = used - elapsed;
  if (Math.abs(diff) < 5) return 'on pace';
  return diff < 0 ? 'under pace' : 'ahead of pace';
}

export function resetText(iso: string | undefined, now = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const ms = at.getTime() - now.getTime();
  if (ms <= 0) return 'resetting now';
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const rel = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at);
  const sameDay = at.toDateString() === now.toDateString();
  let when = time;
  if (!sameDay) {
    when = ms < 6 * 86_400_000
      ? `${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(at)} ${time}`
      : `${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at)} ${time}`;
  }
  return `in ${rel} · ${when}`;
}

export function dailyBudget(window: UsageWindowMetric, now = new Date()): { perDay: number; keepUnder: number; until: 'midnight' | 'reset' } | null {
  if (!window.resetsAt) return null;
  const duration = KIND_DURATION_MS[window.kind];
  if (!duration || duration <= 86_400_000) return null;
  const used = window.usedPercent;
  const resetsAt = new Date(window.resetsAt).getTime();
  if (Number.isNaN(resetsAt)) return null;
  const msLeft = resetsAt - now.getTime();
  const left = Math.max(0, 100 - used);
  const perDay = left / Math.max(1, msLeft / 86_400_000);
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msToMidnight = midnight.getTime() - now.getTime();
  if (msLeft <= msToMidnight) return { perDay, keepUnder: 100, until: 'reset' };
  return { perDay, keepUnder: Math.min(100, used + (left * msToMidnight) / msLeft), until: 'midnight' };
}
