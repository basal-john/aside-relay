import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence } from 'motion/react';
import { Check, CheckCircle2, Circle, CircleDot, Files, ListTodo, LoaderCircle, MessageSquareMore } from 'lucide-react';
import type { UseChat } from './types';
import { Button } from './Button';
import { Dialog, DialogActions, DialogDescription } from './Dialog';
import { isRecord } from './responses';
import { SubagentIcon, subagentColors, type SubagentColor } from './SubagentIcon';
import { tokens } from './tokens.stylex';
import { AsideIcon, ICON_STROKE } from './ui';

const ACTIVE_POLL_INTERVAL_MS = 1_500;
const IDLE_POLL_INTERVAL_MS = 5_000;

type WorkspaceQuestion = {
  id: string;
  title: string;
  prompt: string;
  options: { id: string; label: string; description?: string }[];
  allowsMultiple: boolean;
};

type WorkspaceSuspension = {
  kind: 'approval' | 'action-confirmation' | 'ask-user-question';
  toolCallId: string;
  title: string;
  message?: string;
  questions: WorkspaceQuestion[];
  canAlwaysAllow: boolean;
};

type WorkspaceAgent = {
  id: string;
  title: string;
  status: 'active' | 'complete' | 'failed';
  model?: string;
  duration?: string;
  progress?: string;
  preview?: string;
};

type WorkspaceTodo = {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
};

type WorkspaceOutput = { id: string; name: string };

export type SessionWorkspaceState = {
  sessionId: string;
  status: string;
  summary?: string;
  suspension?: WorkspaceSuspension;
  agents: WorkspaceAgent[];
  todos: WorkspaceTodo[];
  outputs: WorkspaceOutput[];
};

type WorkspacePanel = 'agents' | 'todos' | 'summary';

export function SessionWorkspace({ chat, notify, onOpenSession, onOutputs, onStateChange }: {
  chat: UseChat;
  notify: (message: string, kind?: 'error' | 'success') => void;
  onOpenSession: (sessionId: string) => void;
  onOutputs?: () => void;
  onStateChange?: (state: SessionWorkspaceState | undefined) => void;
}) {
  const [state, setState] = useState<SessionWorkspaceState>();
  const [panel, setPanel] = useState<WorkspacePanel>();
  const [isResolving, setResolving] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [customAnswer, setCustomAnswer] = useState('');
  const [isAlwaysAllowed, setAlwaysAllowed] = useState(false);
  const sessionId = chat.sessionId;
  const publishState = useEffectEvent((next: SessionWorkspaceState | undefined) => onStateChange?.(next));
  const suspensionKey = state?.suspension?.toolCallId;

  useEffect(() => {
    const questions = state?.suspension?.questions ?? [];
    setAnswers(Object.fromEntries(questions.flatMap(question => question.options[0] ? [[question.id, [question.options[0].label]]] : [])));
    setCustomAnswers({});
    setCustomAnswer('');
    setAlwaysAllowed(false);
  }, [suspensionKey]);

  useEffect(() => {
    setState(undefined);
    setPanel(undefined);
    setAnswers({});
    setCustomAnswers({});
    setCustomAnswer('');
    publishState(undefined);
    if (!sessionId) return;
    let isActive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    async function refresh() {
      if (!isActive) return;
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(refresh, IDLE_POLL_INTERVAL_MS);
        return;
      }
      controller = new AbortController();
      try {
        const response = await chat.request(`/api/native/sessions/${encodeURIComponent(sessionId!)}?brief=true`, { signal: controller.signal });
        const next = parseWorkspaceState(await response.json(), sessionId!);
        if (!isActive) return;
        setState(next);
        publishState(next);
        timer = setTimeout(refresh, next.status === 'running' || next.status === 'suspended' ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
      } catch (error) {
        if (!isActive || error instanceof DOMException && error.name === 'AbortError') return;
        timer = setTimeout(refresh, IDLE_POLL_INTERVAL_MS);
      }
    }

    void refresh();
    return () => {
      isActive = false;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [chat.request, sessionId]);

  const agentCounts = useMemo(() => ({
    active: state?.agents.filter(agent => agent.status === 'active').length ?? 0,
    complete: state?.agents.filter(agent => agent.status === 'complete').length ?? 0,
    failed: state?.agents.filter(agent => agent.status === 'failed').length ?? 0,
  }), [state?.agents]);
  const completedTodos = state?.todos.filter(todo => todo.status === 'completed').length ?? 0;
  const hasToolbar = !!state && (state.agents.length > 0 || state.todos.length > 0 || state.outputs.length > 0 || !!state.summary);
  if (!sessionId || !state || (!state.suspension && !hasToolbar)) return undefined;

  async function resolve(response: Record<string, unknown>) {
    await runSuspensionCommand({ command: 'resolve-suspension', response }, 'Response sent.');
  }

  async function cancelQuestion() {
    await runSuspensionCommand({ command: 'cancel-question' }, 'Question canceled.');
  }

  async function runSuspensionCommand(body: Record<string, unknown>, successMessage: string) {
    if (!state?.suspension || isResolving) return;
    const suspension = state.suspension;
    const optimisticState = { ...state, suspension: undefined };
    setResolving(true);
    setState(optimisticState);
    publishState(optimisticState);
    try {
      await chat.request(`/api/native/sessions/${encodeURIComponent(sessionId!)}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      notify(successMessage, 'success');
    } catch {
      setState(current => current ? { ...current, suspension } : current);
      publishState({ ...optimisticState, suspension });
      notify('Could not send the response. Try again.', 'error');
    } finally {
      setResolving(false);
    }
  }

  return <aside aria-label="Session workspace" {...stylex.props(styles.workspace)}>
    {state.suspension && <button type="button" {...stylex.props(styles.attention)} onClick={() => setPanel('summary')}><MessageSquareMore size={16} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>{state.suspension.title}</span><strong>Respond</strong></button>}
    {hasToolbar && <div {...stylex.props(styles.toolbar)}>
      {state.agents.length > 0 && <button type="button" {...stylex.props(styles.chip)} aria-label={`Open agents, ${agentCounts.active} active, ${agentCounts.complete} complete, ${agentCounts.failed} failed`} onClick={() => setPanel('agents')}><AsideIcon size={15} /><span>{state.agents.length} agents</span>{agentCounts.active > 0 && <LoaderCircle size={13} {...stylex.props(styles.spinner)} aria-hidden="true" />}</button>}
      {state.todos.length > 0 && <button type="button" {...stylex.props(styles.chip)} aria-label={`Open tasks, ${completedTodos} of ${state.todos.length} complete`} onClick={() => setPanel('todos')}><ListTodo size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>{completedTodos}/{state.todos.length} tasks</span></button>}
      {state.summary && <button type="button" {...stylex.props(styles.chip)} onClick={() => setPanel('summary')}>Details</button>}
      {state.outputs.length > 0 && onOutputs && <button type="button" {...stylex.props(styles.chip)} onClick={onOutputs}><Files size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>{state.outputs.length} outputs</span></button>}
    </div>}
    <AnimatePresence>{panel && <Dialog key={panel} title={panel === 'agents' ? 'Agents' : panel === 'todos' ? 'Tasks' : state.suspension?.title ?? 'Session details'} onClose={() => setPanel(undefined)}>
      {panel === 'agents' && <AgentPanel agents={state.agents} onOpenSession={onOpenSession} />}
      {panel === 'todos' && <TodoPanel todos={state.todos} />}
      {panel === 'summary' && state.suspension && <SuspensionPanel suspension={state.suspension} answers={answers} customAnswers={customAnswers} customAnswer={customAnswer} isAlwaysAllowed={isAlwaysAllowed} isResolving={isResolving} onAnswer={(id, values) => setAnswers(current => ({ ...current, [id]: values }))} onQuestionCustomAnswer={(id, value) => setCustomAnswers(current => ({ ...current, [id]: value }))} onCustomAnswer={setCustomAnswer} onAlwaysAllowed={setAlwaysAllowed} onResolve={resolve} onCancelQuestion={cancelQuestion} />}
      {panel === 'summary' && !state.suspension && <DialogDescription>{state.summary}</DialogDescription>}
    </Dialog>}</AnimatePresence>
  </aside>;
}

function AgentPanel({ agents, onOpenSession }: {
  agents: WorkspaceAgent[];
  onOpenSession: (sessionId: string) => void;
}) {
  const colors = subagentColors(agents.map(agent => agent.id));
  return agents.length ? <div {...stylex.props(styles.list)}>{(['active', 'complete', 'failed'] as const).map(status => {
    const items = agents.filter(agent => agent.status === status);
    return items.length ? <section key={status} aria-label={`${status} agents`}><h3 {...stylex.props(styles.sectionTitle)}>{status === 'active' ? 'Active' : status === 'complete' ? 'Complete' : 'Failed'} · {items.length}</h3><div {...stylex.props(styles.list)}>{items.map(agent => <AgentCard key={agent.id} agent={agent} color={colors.get(agent.id)} onOpenSession={onOpenSession} />)}</div></section> : undefined;
  })}</div> : <DialogDescription>No agents in this session.</DialogDescription>;
}

function AgentCard({ agent, color, onOpenSession }: { agent: WorkspaceAgent; color?: SubagentColor; onOpenSession: (sessionId: string) => void }) {
  return <article {...stylex.props(styles.card)}>
    <div {...stylex.props(styles.cardHeading)}><SubagentIcon sessionId={agent.id} color={color} /><div {...stylex.props(styles.cardIdentity)}><strong>{agent.title}</strong><span>{[agent.model, agent.duration].filter(Boolean).join(' · ')}</span></div><Status status={agent.status} /></div>
    {agent.progress && <p {...stylex.props(styles.cardText)}>{agent.progress}</p>}
    {agent.preview && <p {...stylex.props(styles.preview)}>{agent.preview}</p>}
    <div {...stylex.props(styles.cardActions)}><Button size="compact" onClick={() => onOpenSession(agent.id)}>{agent.status === 'active' ? 'Open & follow up' : 'Open'}</Button></div>
  </article>;
}

function TodoPanel({ todos }: { todos: WorkspaceTodo[] }) {
  return todos.length ? <ul {...stylex.props(styles.todoList)}>{todos.map(todo => <li key={todo.id} {...stylex.props(styles.todo)}>{todo.status === 'completed' ? <CheckCircle2 size={18} strokeWidth={ICON_STROKE} aria-hidden="true" /> : todo.status === 'in_progress' ? <CircleDot size={18} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Circle size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />}<span>{todo.title}</span></li>)}</ul> : <DialogDescription>No tasks in this session.</DialogDescription>;
}

function SuspensionPanel({ suspension, answers, customAnswers, customAnswer, isAlwaysAllowed, isResolving, onAnswer, onQuestionCustomAnswer, onCustomAnswer, onAlwaysAllowed, onResolve, onCancelQuestion }: {
  suspension: WorkspaceSuspension;
  answers: Record<string, string[]>;
  customAnswers: Record<string, string>;
  customAnswer: string;
  isAlwaysAllowed: boolean;
  isResolving: boolean;
  onAnswer: (id: string, values: string[]) => void;
  onQuestionCustomAnswer: (id: string, value: string) => void;
  onCustomAnswer: (value: string) => void;
  onAlwaysAllowed: (value: boolean) => void;
  onResolve: (response: Record<string, unknown>) => void;
  onCancelQuestion: () => void;
}) {
  if (suspension.kind === 'action-confirmation') return <>
    {suspension.message && <DialogDescription>{suspension.message}</DialogDescription>}
    <label {...stylex.props(styles.label)}>Custom answer<textarea rows={3} maxLength={10_000} value={customAnswer} onChange={event => onCustomAnswer(event.currentTarget.value)} {...stylex.props(styles.textarea)} /></label>
    <DialogActions><Button disabled={isResolving} variant="danger" onClick={() => void onResolve({ verdict: 'cancel', instruction: customAnswer.trim() || undefined })}>{customAnswer.trim() ? 'Send instructions' : 'Cancel action'}</Button><Button disabled={isResolving} variant="primary" onClick={() => void onResolve({ verdict: 'confirm' })}>Confirm</Button></DialogActions>
  </>;
  if (suspension.kind === 'approval') return <>
    {suspension.message && <DialogDescription>{suspension.message}</DialogDescription>}
    {suspension.canAlwaysAllow && <label {...stylex.props(styles.checkbox)}><input type="checkbox" checked={isAlwaysAllowed} onChange={event => onAlwaysAllowed(event.currentTarget.checked)} />Do not ask again for this permission</label>}
    <DialogActions><Button disabled={isResolving} onClick={() => void onResolve({ verdict: 'deny', always: suspension.canAlwaysAllow && isAlwaysAllowed })}>Deny</Button><Button disabled={isResolving} variant="primary" onClick={() => void onResolve({ verdict: 'allow', always: suspension.canAlwaysAllow && isAlwaysAllowed })}>Allow</Button></DialogActions>
  </>;
  const isReady = suspension.questions.every(question => (answers[question.id]?.length ?? 0) > 0 || !!customAnswers[question.id]?.trim());
  return <form onSubmit={event => { event.preventDefault(); void onResolve({ answers: suspension.questions.map(question => ({ header: question.title, answer: customAnswers[question.id]?.trim() ? `custom: ${customAnswers[question.id].trim()}` : (answers[question.id] ?? []).join(', ') })) }); }}>
    {suspension.message && <DialogDescription>{suspension.message}</DialogDescription>}
    <div {...stylex.props(styles.questions)}>{suspension.questions.map(question => <fieldset key={question.id} {...stylex.props(styles.question)}><legend>{question.prompt}</legend>{question.options.map(option => {
      const selected = answers[question.id]?.includes(option.label) ?? false;
      return <label key={option.id} {...stylex.props(styles.option, selected && styles.selectedOption)}><input type={question.allowsMultiple ? 'checkbox' : 'radio'} name={question.id} value={option.id} checked={selected} onChange={() => { onQuestionCustomAnswer(question.id, ''); onAnswer(question.id, question.allowsMultiple ? selected ? (answers[question.id] ?? []).filter(label => label !== option.label) : [...answers[question.id] ?? [], option.label] : [option.label]); }} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{selected && <Check size={17} strokeWidth={ICON_STROKE} aria-hidden="true" />}</label>;
    })}<label {...stylex.props(styles.label)}>Custom answer<input maxLength={10_000} value={customAnswers[question.id] ?? ''} onChange={event => { onQuestionCustomAnswer(question.id, event.currentTarget.value); if (event.currentTarget.value) onAnswer(question.id, []); }} {...stylex.props(styles.answerInput)} /></label></fieldset>)}</div>
    <DialogActions><Button disabled={isResolving} onClick={() => void onCancelQuestion()}>Cancel</Button><Button type="submit" variant="primary" disabled={isResolving || !isReady}>Submit</Button></DialogActions>
  </form>;
}

function Status({ status }: { status: WorkspaceAgent['status'] }) {
  return <span {...stylex.props(styles.status, status === 'failed' && styles.failed)}>{status === 'active' && <LoaderCircle size={13} {...stylex.props(styles.spinner)} aria-hidden="true" />}{status === 'complete' ? 'Complete' : status === 'failed' ? 'Failed' : 'Active'}</span>;
}

function parseWorkspaceState(value: unknown, sessionId: string): SessionWorkspaceState {
  if (!isRecord(value)) throw new Error('Invalid workspace response');
  const session = isRecord(value.session) ? value.session : value;
  const suspension = parseSuspension(isRecord(value.suspension) ? value.suspension : isRecord(session.suspension) ? session.suspension : undefined);
  const children = Array.isArray(value.children) ? value.children : [];
  const subagents = Array.isArray(value.subagents) ? value.subagents : [];
  return {
    sessionId,
    status: typeof session.status === 'string' ? session.status : 'idle',
    summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary : undefined,
    suspension,
    agents: mergeAgents(children, subagents),
    todos: Array.isArray(value.todos) ? value.todos.flatMap(parseTodo) : [],
    outputs: Array.isArray(value.outputs) ? value.outputs.flatMap(parseOutput) : [],
  };
}

function parseSuspension(value: Record<string, unknown> | undefined): WorkspaceSuspension | undefined {
  if (!value || typeof value.kind !== 'string') return;
  const kind = value.kind === 'action-confirmation' || value.kind === 'ask-user-question' ? value.kind : value.kind === 'approval' || value.kind === 'permission-approval' ? 'approval' : undefined;
  if (!kind) return;
  const request = isRecord(value.request) ? value.request : undefined;
  const source = isRecord(request?.source) ? request.source : undefined;
  const rawQuestions = Array.isArray(value.questions) ? value.questions : Array.isArray(request?.questions) ? request.questions : [];
  const questions = rawQuestions.flatMap(parseQuestion);
  return {
    kind,
    toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : typeof value.tool_call_id === 'string' ? value.tool_call_id : '',
    title: getText(value.title, request?.title) ?? (kind === 'ask-user-question' ? 'Aside needs your answer' : kind === 'approval' ? 'Approval needed' : 'Confirmation needed'),
    message: getText(value.message, request?.message, request?.description) ?? (kind === 'approval' ? describeApproval(request?.scope) : undefined),
    questions,
    canAlwaysAllow: !(typeof source?.taskId === 'string' && source.taskId.length > 0),
  };
}

function parseQuestion(value: unknown, index: number): WorkspaceQuestion[] {
  if (!isRecord(value)) return [];
  const options = Array.isArray(value.options) ? value.options.flatMap(option => {
    if (typeof option === 'string') return [{ id: option, label: option }];
    if (!isRecord(option)) return [];
    const label = typeof option.label === 'string' ? option.label : typeof option.title === 'string' ? option.title : undefined;
    return label ? [{ id: typeof option.id === 'string' ? option.id : label, label, description: typeof option.description === 'string' ? option.description : undefined }] : [];
  }) : [];
  const prompt = typeof value.question === 'string' ? value.question : typeof value.prompt === 'string' ? value.prompt : undefined;
  if (!prompt) return [];
  return [{ id: typeof value.id === 'string' ? value.id : `question-${index}`, title: getText(value.header, value.title) ?? prompt, prompt, options, allowsMultiple: value.multiple === true || value.allowsMultiple === true }];
}

function mergeAgents(children: unknown[], subagents: unknown[]) {
  const metadata = new Map(subagents.flatMap(value => {
    if (!isRecord(value) || typeof value.sessionId !== 'string') return [];
    return [[value.sessionId, value] as const];
  }));
  const agents = children.flatMap(value => parseAgent(value, isRecord(value) && typeof value.id === 'string' ? metadata.get(value.id) : undefined));
  const childIds = new Set(agents.map(agent => agent.id));
  return [...agents, ...subagents.flatMap(value => isRecord(value) && typeof value.sessionId === 'string' && !childIds.has(value.sessionId) ? parseAgent({ id: value.sessionId, status: value.isRunning === true ? 'running' : 'idle' }, value) : [])];
}

function parseAgent(value: unknown, metadata?: Record<string, unknown>): WorkspaceAgent[] {
  if (!isRecord(value) || typeof value.id !== 'string') return [];
  const rawStatus = typeof value.status === 'string' ? value.status : '';
  const status = ['running', 'suspended', 'active'].includes(rawStatus) ? 'active' : ['errored', 'failed', 'aborted', 'interrupted'].includes(rawStatus) ? 'failed' : 'complete';
  return [{ id: value.id, title: getText(value.title, metadata?.description) ?? 'Subagent', status, model: formatModel(value.model) ?? formatModel(metadata?.model), duration: durationBetween(value.createdAt, value.updatedAt), progress: getText(value.progress, metadata?.progress), preview: getText(value.preview, metadata?.preview) }];
}

function formatModel(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isRecord(value)) return;
  const model = getText(value.modelId, value.model);
  if (!model) return;
  const effort = getText(value.thinkingLevel);
  return effort ? `${model} · ${effort}` : model;
}

function durationBetween(start: unknown, end: unknown) {
  if (typeof start !== 'string' || typeof end !== 'string') return;
  const milliseconds = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function getText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function describeApproval(value: unknown) {
  if (!isRecord(value) || typeof value.type !== 'string') return;
  if (value.type === 'tool') return typeof value.tool === 'string' ? `Run ${value.tool}` : 'Run a tool';
  if (value.type === 'file') return `${value.mode === 'read' ? 'Read' : 'Write'} ${typeof value.path === 'string' ? value.path : 'a file'}`;
  if (value.type === 'browser') return `${value.action === 'read' ? 'Read' : value.action === 'modify' ? 'Modify' : 'Download from'} browser${typeof value.url === 'string' ? ` · ${value.url}` : ''}`;
  return `Access network${typeof value.url === 'string' ? ` · ${value.url}` : ''}`;
}

function parseTodo(value: unknown, index: number): WorkspaceTodo[] {
  if (!isRecord(value)) return [];
  const title = typeof value.title === 'string' ? value.title : typeof value.content === 'string' ? value.content : undefined;
  if (!title) return [];
  const status = value.status === 'completed' || value.status === 'in_progress' ? value.status : 'pending';
  return [{ id: typeof value.id === 'string' ? value.id : `todo-${index}`, title, status }];
}

function parseOutput(value: unknown, index: number): WorkspaceOutput[] {
  if (typeof value === 'string' && value.trim()) return [{ id: value, name: value.split('/').filter(Boolean).at(-1) ?? value }];
  if (!isRecord(value)) return [];
  const name = getText(value.name, value.title, value.filename, value.path);
  return name ? [{ id: typeof value.id === 'string' ? value.id : `output-${index}`, name }] : [];
}

const styles = stylex.create({
  workspace: { position: 'absolute', zIndex: 7, left: 'max(16px, env(safe-area-inset-left))', right: 'max(16px, env(safe-area-inset-right))', bottom: 'calc(var(--composer-height, 76px) + 8px)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, pointerEvents: 'none' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, maxWidth: '100%', pointerEvents: 'auto' },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 34, minWidth: 0, padding: '6px 11px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.glassBorder, borderRadius: 999, backgroundColor: tokens.glass, backdropFilter: 'blur(18px) saturate(150%)', boxShadow: tokens.glassShadow, color: tokens.muted, fontSize: '0.75rem', fontWeight: 550, whiteSpace: 'nowrap' },
  attention: { display: 'flex', alignItems: 'center', gap: 8, width: 'min(100%, 440px)', minHeight: 40, padding: '8px 12px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.primary, borderRadius: 14, backgroundColor: tokens.surface, color: tokens.text, boxShadow: tokens.glassShadow, pointerEvents: 'auto', textAlign: 'left', fontSize: '0.8125rem' },
  spinner: { animationName: stylex.keyframes({ to: { transform: 'rotate(360deg)' } }), animationDuration: '1s', animationTimingFunction: 'linear', animationIterationCount: 'infinite' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  sectionTitle: { margin: '0 0 7px 2px', color: tokens.muted, fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' },
  card: { padding: 14, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 16, backgroundColor: tokens.canvas },
  cardHeading: { display: 'flex', alignItems: 'flex-start', gap: 9, minWidth: 0 },
  cardIdentity: { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 2, fontSize: '0.875rem', overflowWrap: 'anywhere' },
  cardText: { margin: '9px 0 0', color: tokens.text, fontSize: '0.8125rem', lineHeight: 1.5, overflowWrap: 'anywhere' },
  preview: { margin: '6px 0 0', color: tokens.muted, fontSize: '0.75rem', lineHeight: 1.5, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' },
  cardActions: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 },
  status: { display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, color: tokens.muted, fontSize: '0.6875rem', textTransform: 'capitalize' },
  failed: { color: tokens.danger },
  todoList: { display: 'flex', flexDirection: 'column', gap: 2, margin: 0, padding: 0, listStyle: 'none' },
  todo: { display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 4px', color: tokens.text, fontSize: '0.875rem', lineHeight: 1.5 },
  label: { display: 'flex', flexDirection: 'column', gap: 7, color: tokens.muted, fontSize: '0.8125rem' },
  checkbox: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, color: tokens.text, fontSize: '0.8125rem' },
  textarea: { width: '100%', resize: 'vertical', minHeight: 82, padding: '10px 12px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 12, backgroundColor: tokens.canvas, color: tokens.text, fontSize: '0.9375rem', lineHeight: 1.5 },
  answerInput: { width: '100%', minHeight: 40, padding: '8px 11px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 11, backgroundColor: tokens.canvas, color: tokens.text, fontSize: '0.875rem' },
  questions: { display: 'flex', flexDirection: 'column', gap: 16 },
  question: { display: 'flex', flexDirection: 'column', gap: 7, margin: 0, padding: 0, borderWidth: 0, color: tokens.text, fontSize: '0.875rem' },
  option: { display: 'flex', alignItems: 'center', gap: 9, minHeight: 44, padding: '9px 11px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 13, backgroundColor: tokens.canvas, color: tokens.text, overflowWrap: 'anywhere' },
  selectedOption: { borderColor: tokens.primary, backgroundColor: tokens.hover },
});
