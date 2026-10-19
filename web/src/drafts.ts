export type DraftData = Record<string, unknown>;
export type DraftKind = 'mail' | 'imessage' | 'slack' | 'linkedin' | 'calendar' | 'x';
export type Draft = { kind: DraftKind; label: string; fields: [string, string][]; thread: { name: string; message: string }[]; body: string; action?: string };

/** Fence languages emitted by Aside's built-in draft-preview skill, matching the native app's renderer list. */
export const DRAFT_LANGUAGES = new Set(['calendar-draft', 'calendar-event-draft', 'gmail-draft', 'imessage-draft', 'linkedin-draft', 'linkedin-message-draft', 'linkedin-post', 'linkedin-post-draft', 'slack-draft', 'slack-message-draft', 'tweet', 'tweet-draft', 'x-post', 'x-post-draft', 'x-tweet', 'x-tweet-draft']);

const isRecord = (value: unknown): value is DraftData => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
const list = (value: unknown) => (Array.isArray(value) ? value : value != null && value !== '' ? [value] : []).map(item => text(item)).filter(Boolean);
const records = (value: unknown) => Array.isArray(value) ? value.filter(isRecord) : [];

/**
 * Parses a draft fence body the way Aside does, unwrapping `{ type, data }` envelopes.
 * Returns undefined for anything that is not a JSON object so the caller can fall back to a code block.
 */
export function parseDraft(source: string): DraftData | undefined {
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) return;
    return typeof value.type === 'string' && isRecord(value.data) ? value.data : value;
  } catch { return; }
}

/**
 * Maps a parsed draft to display fields. `action` is the follow-up the native app sends when its
 * button is pressed, and is only set for the same card types that have a button there.
 */
export function describeDraft(language: string, data: DraftData): Draft {
  const draft = text(data.draft) || text(data.body);
  const thread = records(data.messages).map(message => ({ name: message.sender === 'me' ? 'Me' : text(message.name) || (message.sender === 'them' ? 'Them' : ''), message: text(message.message) })).filter(message => message.message);
  const profile = isRecord(data.profile) ? data.profile : data;
  const author = [text(profile.authorName), text(profile.handle) && '@' + text(profile.handle), text(profile.headline)].filter(Boolean).join(' · ');
  switch (language) {
    case 'gmail-draft':
      return { kind: 'mail', label: 'Email draft', fields: [['To', list(data.to).join(', ')], ['Cc', list(data.cc).join(', ')], ['Bcc', list(data.bcc).join(', ')], ['Subject', text(data.subject)]], thread: [], body: text(data.body), action: 'Send' };
    case 'imessage-draft':
      return { kind: 'imessage', label: 'iMessage draft', fields: [['To', text(data.to) || list(data.to).join(', ')], ['Files', list(data.attachments ?? data.attachment ?? data.attachmentPaths ?? data.attachmentPath).join(', ')]], thread, body: draft, action: 'Send' };
    case 'slack-draft': case 'slack-message-draft':
      return { kind: 'slack', label: 'Slack draft', fields: [['Where', `${text(data.workspace, 'Slack')} · #${text(data.channel, 'channel')}`]], thread, body: draft };
    case 'linkedin-draft': case 'linkedin-message-draft':
      return { kind: 'linkedin', label: 'LinkedIn message', fields: [['To', records(data.profiles).map(item => text(item.name)).filter(Boolean).join(', ')]], thread, body: draft };
    case 'calendar-event-draft': case 'calendar-draft':
      return { kind: 'calendar', label: 'Calendar invite', fields: [['Title', text(data.title)], ['When', text(data.time)], ['Calendar', text(data.calendarName, 'Calendar')], ['Where', text(data.location)], ['Guests', records(data.attendees).map(item => text(item.name) || text(item.email)).filter(Boolean).join(', ')], ['Reminder', text(data.reminder)], ['Description', text(data.description)]], thread: [], body: draft, action: 'Send invite' };
    case 'linkedin-post': case 'linkedin-post-draft':
      return { kind: 'linkedin', label: language === 'linkedin-post' ? 'LinkedIn post' : 'LinkedIn post draft', fields: [['Author', author]], thread: [], body: text(data.body), action: language === 'linkedin-post' ? undefined : 'Post' };
    default:
      return { kind: 'x', label: language.endsWith('-draft') ? 'X post draft' : 'X post', fields: [['Author', author]], thread: [], body: text(data.body), action: language.endsWith('-draft') ? 'Post' : undefined };
  }
}
