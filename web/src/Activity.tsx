import * as stylex from '@stylexjs/stylex';
import { ChevronDown, ChevronRight, CodeXml, File, FilePenLine, Globe, History, ListTodo, NotebookPen, Search, Terminal } from 'lucide-react';
import type { ChatMessage, ToolCallBlock } from './types';
import { isRecord } from './responses';
import { tokens } from './tokens.stylex';
import { AsideIcon, ICON_STROKE } from './ui';

const TOOL_TITLES: Record<string, string> = { repl: 'Ran actions', history_search: 'Searched browsing history', memory_search: 'Searched memory', read_file: 'Read file', edit_file: 'Edited file', web_search: 'Searched the web', websearch: 'Searched the web', webfetch: 'Read web page', bash: 'Ran a command', write_todos: 'Updated tasks', subagent: 'Subagent', subagent_wait: 'Waited for subagents', message_agent: 'Messaged subagent' };
const SUMMARY_LABEL_LIMIT = 3;

function toolKind(name: string) {
  if (/subagent|message_agent/.test(name)) return 'agent';
  if (/web_?search/.test(name)) return 'search';
  if (/webfetch|browser/.test(name)) return 'web';
  if (/read_file/.test(name)) return 'file';
  if (/edit_file|write_file/.test(name)) return 'edit';
  if (/history/.test(name)) return 'history';
  if (/memory/.test(name)) return 'memory';
  if (/todo/.test(name)) return 'tasks';
  if (/bash|shell|terminal/.test(name)) return 'command';
  return 'code';
}

function ToolIcon({ name }: { name: string }) {
  const kind = toolKind(name);
  const Icon = { search: Search, web: Globe, file: File, edit: FilePenLine, history: History, memory: NotebookPen, tasks: ListTodo, command: Terminal, code: CodeXml, agent: AsideIcon }[kind];
  return <span {...stylex.props(styles.icon, kind === 'agent' && styles.agentIcon)} aria-hidden="true"><Icon size={18} strokeWidth={ICON_STROKE} /></span>;
}

export function Activity({ messages, results, onZoom, expanded, onExpandedChange }: { messages: ChatMessage[]; results: Map<string, ChatMessage>; onZoom: (src: string) => void; expanded: Record<string, boolean>; onExpandedChange: (id: string, isOpen: boolean) => void }) {
  const calls = messages.flatMap(message => message.blocks.flatMap((block, index) => block.type === 'toolCall' ? [{ block, key: `${message.seq}-${index}`, result: block.id ? results.get(block.id) : undefined }] : []));
  const notes = messages.flatMap(message => message.blocks.flatMap((block, index) => block.type === 'thinking' && block.text.trim() ? [{ text: block.text, key: `${message.seq}-${index}` }] : []));
  const standalone = messages.filter(message => message.role === 'toolResult' || message.role === 'system');
  const rootId = 'activity-' + messages[0].seq;
  const kinds = calls.map(call => toolKind(call.block.name ?? ''));
  const labels = [...new Set(kinds)].map(kind => {
    const count = kinds.filter(value => value === kind).length;
    if (kind === 'file') return `Read ${count === 1 ? 'a file' : count + ' files'}`;
    if (kind === 'edit') return `Edited ${count === 1 ? 'a file' : count + ' files'}`;
    if (kind === 'agent') return `Used ${count === 1 ? 'a subagent' : 'subagents'}`;
    return { search: 'Searched the web', web: 'Browsed the web', history: 'Searched browsing history', memory: 'Searched memory', tasks: 'Updated tasks', command: 'Ran commands', code: 'Ran actions' }[kind];
  });
  const singleArgs = calls.length === 1 && isRecord(calls[0].block.args) ? calls[0].block.args : undefined;
  const summary = typeof singleArgs?.title === 'string' && singleArgs.title.trim() ? singleArgs.title : labels.slice(0, SUMMARY_LABEL_LIMIT).map((label, index) => index ? label.charAt(0).toLowerCase() + label.slice(1) : label).join(', ') + (labels.length > SUMMARY_LABEL_LIMIT ? ` +${labels.length - SUMMARY_LABEL_LIMIT} more` : '') || 'Activity';
  return <details open={expanded[rootId] ?? false} onToggle={event => { if (event.target === event.currentTarget) onExpandedChange(rootId, event.currentTarget.open); }} {...stylex.props(styles.activity)}><summary {...stylex.props(styles.summary)}><ToolIcon name={calls[0]?.block.name ?? standalone[0]?.toolName ?? ''} /><span>{summary}</span>{expanded[rootId] ? <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}</summary>
    {expanded[rootId] && <div {...stylex.props(styles.body)}>
      {notes.map(note => <details key={note.key} open={expanded[note.key] ?? false} onToggle={event => onExpandedChange(note.key, event.currentTarget.open)} {...stylex.props(styles.notes)}><summary {...stylex.props(styles.summary)}><ChevronRight size={14} aria-hidden="true" />Notes</summary><p {...stylex.props(styles.description)}>{note.text}</p></details>)}
      {calls.map(call => <Action key={call.key} call={call.block} result={call.result} onZoom={onZoom} isExpanded={expanded[call.key] ?? false} onExpandedChange={isOpen => onExpandedChange(call.key, isOpen)} />)}
      {standalone.map(message => <Action key={message.seq} result={message} onZoom={onZoom} isExpanded={expanded[String(message.seq)] ?? false} onExpandedChange={isOpen => onExpandedChange(String(message.seq), isOpen)} />)}
    </div>}
  </details>;
}

function Action({ call, result, onZoom, isExpanded, onExpandedChange }: { call?: ToolCallBlock; result?: ChatMessage; onZoom: (src: string) => void; isExpanded: boolean; onExpandedChange: (isOpen: boolean) => void }) {
  const args = isRecord(call?.args) ? call.args : undefined;
  const name = call?.name ?? result?.toolName ?? '';
  const isSubagent = toolKind(name) === 'agent';
  const title = typeof args?.title === 'string' && args.title.trim() ? args.title : isSubagent && typeof args?.description === 'string' ? args.description : TOOL_TITLES[name] ?? (name.replace(/[_-]/g, ' ') || 'Activity');
  const filePath = typeof args?.path === 'string' ? args.path : typeof args?.file_path === 'string' ? args.file_path : undefined;
  const fileMatch = filePath?.match(/^\/Users\/[^/]+\/\.aside\/u\/\d+\/sessions\/[^/]+_([^/]+)\/(.+)$/);
  const fileUrl = fileMatch ? `/api/sessions/${encodeURIComponent(fileMatch[1])}/file/${fileMatch[2].split('/').map(encodeURIComponent).join('/')}` : undefined;
  const output = result?.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim() ?? '';
  const model = isSubagent ? output.match(/^model:\s*(.+)$/m)?.[1] : undefined;
  const isSkipped = /\b(?:was skipped|not a completed search)\b/i.test(output);
  const status = result?.isError ? 'Failed' : isSkipped ? 'Unavailable' : result?.role === 'system' ? 'Notice' : isSubagent && args?.action === 'spawn' ? 'Started' : result ? 'Completed' : 'Started';
  const page = output.match(/(?:^|\n)[+-]?\s*-\s*title:\s*"([^"\n]+)"\s*\[url=(https?:\/\/[^\]]+)\]/) ?? output.match(/→\s*([^\n]+?)\s*\((https?:\/\/[^\s)]+)\)/);
  const pageUrl = page && URL.canParse(page[2]) ? new URL(page[2]) : undefined;
  const queries = Array.isArray(args?.queries) ? args.queries.filter((query): query is string => typeof query === 'string') : typeof args?.query === 'string' ? [args.query] : [];
  const isSnapshot = /(?:^|\n)(?:[+-]?\s*-\s*(?:title|generic|text|link|button)|@@)/.test(output);
  const observed = output.split('\n').flatMap(line => {
    const match = line.match(/^\+\s*-\s*(?:text|heading|link)(?:\s+\[.*?\])?:?\s*"([^"\n]+)"/);
    return match ? [match[1]] : [];
  }).filter((text, index, all) => !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(text) && !/광고|advertisement/i.test(text) && all.indexOf(text) === index).slice(0, 4);
  const lines = output.split('\n').filter(line => line.trim() && !/^\s*(?:at |# |\[Output too large|Preview|Displayed image|Image original|\[Try |@@|[+-]- )/.test(line));
  const description = describeResult();
  const images = result?.blocks.filter(block => block.type === 'image') ?? [];
  const input = args && Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'title' && key !== 'code'));
  const hasInput = input && Object.keys(input).length > 0;
  return <section aria-label={title} {...stylex.props(styles.action)}>
    <span {...stylex.props(styles.branch)} aria-hidden="true" />
    <div {...stylex.props(styles.heading)}><ToolIcon name={name} /><strong {...stylex.props(styles.title)}>{title}</strong><span {...stylex.props(styles.status, (result?.isError || isSkipped) && styles.error)}>{status}</span></div>
    {filePath && <div {...stylex.props(styles.path)} title={filePath}><File size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />{fileUrl ? <a href={fileUrl} target="_blank" rel="noopener noreferrer" {...stylex.props(styles.fileLink)}>{filePath.split('/').filter(Boolean).slice(-3).join(' / ')}</a> : <span {...stylex.props(styles.pathText)}>{filePath.split('/').filter(Boolean).slice(-3).join(' / ')}</span>}</div>}
    {model && <p {...stylex.props(styles.model)}>{model}</p>}
    {queries.length > 0 && <p {...stylex.props(styles.query)}>{queries.join(' · ')}</p>}
    {page && pageUrl && <a href={pageUrl.href} target="_blank" rel="noopener noreferrer" {...stylex.props(styles.page)}>{page[1]}<span {...stylex.props(styles.domain)}>{pageUrl.hostname}</span></a>}
    {description && <p {...stylex.props(styles.description)}>{description.slice(0, 600)}</p>}
    {observed.length > 0 && <ul {...stylex.props(styles.changes)}>{observed.map(text => <li key={text}>{text.slice(0, 180)}</li>)}</ul>}
    {images.map((block, index) => block.type === 'image' ? <button key={index} type="button" aria-label="View activity screenshot" {...stylex.props(styles.imageButton)} onClick={() => onZoom('/api/media/' + block.mediaId)}><img src={'/api/media/' + block.mediaId} alt="Activity screenshot" loading="lazy" {...stylex.props(styles.image)} /></button> : undefined)}
    {(output || args) && <details open={isExpanded} onToggle={event => onExpandedChange(event.currentTarget.open)} {...stylex.props(styles.technical)}><summary {...stylex.props(styles.summary)}><ChevronRight size={13} aria-hidden="true" />Technical details</summary>
      {isExpanded && <>{name && <span {...stylex.props(styles.label)}>Tool · {name}</span>}
      {hasInput && <><span {...stylex.props(styles.label)}>Input</span><pre {...stylex.props(styles.output)}>{JSON.stringify(input, undefined, 2)}</pre></>}
      {typeof args?.code === 'string' && <><span {...stylex.props(styles.label)}>Code</span><pre {...stylex.props(styles.output)}>{args.code}</pre></>}
      {output && <><span {...stylex.props(styles.label)}>Result</span><pre {...stylex.props(styles.output)}>{output}</pre></>}</>}
    </details>}
  </section>;

  function describeResult() {
    if (result?.isError) return /RefStaleError/.test(output) ? 'The page changed before this action could finish.' : lines[0]?.replace(/^Error:\s*/, '');
    if (isSkipped) return output.split(/(?<=[.!?])\s/)[0];
    if (isSubagent && args?.action === 'spawn') return;
    if (output === '[]') return 'No open tabs.';
    if (/^\(no matching history\)/.test(output)) return 'No matching history.';
    if (observed.length) return;
    if (isSnapshot) return 'Page inspected.';
    if (page) return;
    return lines.filter(line => !/^[\[\]{}]/.test(line)).slice(0, 3).join('\n');
  }
}

const styles = stylex.create({
  activity: { color: tokens.muted, fontSize: '0.8125rem', minWidth: 0 },
  summary: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', listStyle: 'none', minHeight: 32, overflowWrap: 'anywhere' },
  body: { borderLeftWidth: 1, borderLeftStyle: 'solid', borderLeftColor: tokens.border, marginLeft: 9, paddingLeft: 18, paddingBottom: 6, minWidth: 0 },
  action: { position: 'relative', minWidth: 0, padding: '8px 0' },
  branch: { position: 'absolute', left: -19, top: 0, width: 13, height: 18, borderLeftWidth: 1, borderBottomWidth: 1, borderStyle: 'solid', borderTopWidth: 0, borderRightWidth: 0, borderColor: tokens.border, borderBottomLeftRadius: 9, pointerEvents: 'none' },
  icon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 20, flexShrink: 0, color: tokens.muted },
  agentIcon: { color: tokens.primary },
  heading: { display: 'flex', alignItems: 'flex-start', gap: 7, minWidth: 0, lineHeight: 1.5 },
  title: { flex: 1, minWidth: 0, color: tokens.text, fontSize: '0.8125rem', fontWeight: 550, overflowWrap: 'anywhere' },
  status: { flexShrink: 0, fontSize: '0.6875rem', lineHeight: 1.8 },
  error: { color: tokens.danger },
  path: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, margin: '3px 0 0 25px', fontSize: '0.6875rem', lineHeight: 1.5 },
  pathText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  fileLink: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: tokens.primary, textDecoration: 'none', ':hover': { textDecoration: 'underline' } },
  model: { margin: '3px 0 0 25px', color: tokens.muted, fontSize: '0.6875rem', overflowWrap: 'anywhere' },
  query: { margin: '4px 0 0 22px', overflowWrap: 'anywhere', lineHeight: 1.5 },
  page: { display: 'block', margin: '4px 0 0 22px', color: tokens.text, overflowWrap: 'anywhere', lineHeight: 1.5 },
  domain: { display: 'block', color: tokens.muted, fontSize: '0.6875rem', textDecoration: 'none' },
  description: { margin: '4px 0 0 22px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55, color: tokens.muted },
  changes: { margin: '4px 0 0 22px', paddingLeft: 16, overflowWrap: 'anywhere', lineHeight: 1.55, fontSize: '0.75rem', color: tokens.muted },
  notes: { minWidth: 0 },
  technical: { marginLeft: 22, fontSize: '0.75rem' },
  label: { display: 'block', margin: '4px 0', fontSize: '0.6875rem' },
  output: { fontSize: '0.75rem', lineHeight: 'var(--code-line-height)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, padding: '8px 10px', backgroundColor: tokens.surface, borderRadius: 10, maxHeight: 240, overflowY: 'auto' },
  imageButton: { display: 'block', width: 'calc(100% - 22px)', margin: '6px 0 0 22px', padding: 0, borderWidth: 0, backgroundColor: 'transparent', cursor: 'zoom-in' },
  image: { display: 'block', width: '100%', height: 144, borderRadius: 10, objectFit: 'contain' },
});
