import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AtSign, Briefcase, Calendar, Code2, Copy, Mail, MessageCircle, MessageSquare, Send } from 'lucide-react';
import { tokens } from './tokens.stylex';
import { Button } from './Button';
import { describeDraft, type DraftData, type DraftKind } from './drafts';

const icons: Record<DraftKind, typeof Mail> = { mail: Mail, imessage: MessageCircle, slack: MessageSquare, linkedin: Briefcase, calendar: Calendar, x: AtSign };

/**
 * Renders an Aside draft-preview fence as a card. The action button asks for a second tap,
 * then sends its label back to the agent as a follow-up, as the native app's button does.
 */
export function DraftCard({ language, data, source, notify, onAction }: { language: string; data: DraftData; source: string; notify: (text: string, kind?: 'success' | 'error') => void; onAction?: (text: string) => void }) {
  const draft = describeDraft(language, data);
  const Icon = icons[draft.kind];
  const [isSource, setSource] = useState(false);
  const [isArmed, setArmed] = useState(false);
  useEffect(() => { if (!isArmed) return; const timer = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(timer); }, [isArmed]);
  const fields = draft.fields.filter(([, value]) => value);
  async function copy() {
    try { await navigator.clipboard.writeText(draft.body); notify('Draft copied', 'success'); }
    catch { notify('Could not copy. Select the text to copy it.', 'error'); }
  }
  function act() {
    if (!draft.action || !onAction) return;
    if (!isArmed) { setArmed(true); return; }
    setArmed(false); onAction(draft.action);
  }
  return <section aria-label={draft.label} {...stylex.props(styles.card)}>
    <header {...stylex.props(styles.header)}><span {...stylex.props(styles.title)}><Icon size={16} aria-hidden="true" />{draft.label}</span><Button size="compact" aria-label={isSource ? 'Show draft' : 'Show draft source'} onClick={() => setSource(!isSource)}><Code2 size={16} aria-hidden="true" />{isSource ? 'Draft' : 'JSON'}</Button></header>
    {isSource ? <pre role="region" aria-label="Draft source" tabIndex={0} {...stylex.props(styles.source)}>{source}</pre> : <>
      {fields.length > 0 && <dl {...stylex.props(styles.fields)}>{fields.map(([name, value]) => <div key={name} {...stylex.props(styles.field)}><dt {...stylex.props(styles.fieldName)}>{name}</dt><dd {...stylex.props(styles.fieldValue)}>{value}</dd></div>)}</dl>}
      {draft.thread.length > 0 && <div {...stylex.props(styles.thread)}>{draft.thread.map((message, index) => <p key={index} {...stylex.props(styles.threadLine)}><strong>{message.name}</strong> {message.message}</p>)}</div>}
      {draft.body && <div {...stylex.props(styles.body)}>{draft.body}</div>}
    </>}
    <footer {...stylex.props(styles.actions)}>
      <Button onClick={() => { void copy(); }}><Copy size={16} aria-hidden="true" />Copy</Button>
      {draft.action && onAction && <Button variant={isArmed ? 'danger' : 'primary'} onClick={act}><Send size={16} aria-hidden="true" />{isArmed ? `Tap again to ${draft.action.toLowerCase()}` : draft.action}</Button>}
    </footer>
  </section>;
}

const styles = stylex.create({
  card: { minWidth: 0, maxWidth: '100%', borderRadius: 16, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, overflow: 'hidden', marginTop: 16, marginBottom: 20, backgroundColor: tokens.surface },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 6px 6px 16px', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border },
  title: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.8125rem', fontWeight: 600, color: tokens.muted },
  fields: { margin: 0, padding: '10px 16px 4px', display: 'flex', flexDirection: 'column', gap: 6 },
  field: { display: 'grid', gridTemplateColumns: '5.5rem 1fr', gap: 8, fontSize: '0.875rem', lineHeight: 1.45 },
  fieldName: { color: tokens.muted },
  fieldValue: { margin: 0, color: tokens.text, overflowWrap: 'anywhere' },
  thread: { margin: '8px 16px 0', padding: '8px 12px', borderRadius: 12, backgroundColor: tokens.canvas, fontSize: '0.8125rem', color: tokens.muted },
  threadLine: { margin: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
  body: { margin: '10px 16px 4px', paddingTop: 10, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: tokens.border, fontFamily: 'var(--font-content)', fontSize: '1rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: tokens.text },
  source: { margin: 0, padding: 16, maxHeight: '50svh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.8125rem' },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, padding: '10px 12px 12px' },
});
