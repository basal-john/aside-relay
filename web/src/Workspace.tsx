import { useCallback, useEffect, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Archive, Bot, Brain, CalendarClock, ChevronLeft, CircleUserRound, FolderKanban, History, KeyRound, Pause, Play, Plug, Plus, RefreshCw, Save, ShieldCheck, Sparkles, Trash2, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { UseChat } from './types';
import { Button } from './Button';
import { Dialog, DialogActions, DialogDescription } from './Dialog';
import { ICON_STROKE, styles as ui } from './ui';
import { tokens } from './tokens.stylex';

export type WorkspaceSection = 'projects' | 'routines' | 'memories' | 'contextAwareness' | 'skills' | 'connections' | 'providers' | 'account' | 'preferences';

type JsonObject = Record<string, unknown>;
type WorkspaceData = {
  available: boolean;
  capabilities: Partial<Record<WorkspaceSection | 'projectInstructions' | 'skillCatalog' | 'skillCustomization' | 'toolPermissions', boolean>>;
  sections: Partial<Record<WorkspaceSection, unknown>>;
};

type FormDialog = {
  title: string;
  description: string;
  fields: FormField[];
  submitLabel: string;
  danger?: boolean;
  onSubmit: (values: Record<string, string | boolean>) => Promise<unknown>;
};

type FormField = {
  key: string;
  label: string;
  value?: string | boolean;
  placeholder?: string;
  kind?: 'text' | 'textarea' | 'password' | 'checkbox' | 'number' | 'select';
  options?: { value: string; label: string }[];
  required?: boolean;
};

const SECTION_META: { id: WorkspaceSection; title: string; description: string; icon: LucideIcon }[] = [
  { id: 'projects', title: 'Projects', description: 'Working folders and project instructions', icon: FolderKanban },
  { id: 'routines', title: 'Routines', description: 'Scheduled prompts and run history', icon: CalendarClock },
  { id: 'memories', title: 'Memory', description: 'Saved context and retention', icon: Brain },
  { id: 'contextAwareness', title: 'Context awareness', description: 'Capture, exclusions and history', icon: History },
  { id: 'skills', title: 'Skills', description: 'Create, import and edit skills', icon: Sparkles },
  { id: 'connections', title: 'Plugins & MCP', description: 'Connections, tools and permissions', icon: Plug },
  { id: 'providers', title: 'AI providers', description: 'Provider connections and credentials', icon: Bot },
  { id: 'account', title: 'Account & devices', description: 'Signed-in account and active devices', icon: CircleUserRound },
  { id: 'preferences', title: 'Native preferences', description: 'Permissions, queueing and cleanup', icon: Wrench },
];

export function Workspace({ chat, notify, onOpenSession, onNewProjectChat, initialSection }: {
  chat: UseChat;
  notify: (text: string, kind?: 'error' | 'success') => void;
  onOpenSession?: (sessionId: string) => void;
  onNewProjectChat?: (projectId: string) => void;
  initialSection?: WorkspaceSection;
}) {
  const [data, setData] = useState<WorkspaceData>();
  const [sectionData, setSectionData] = useState<Partial<Record<WorkspaceSection, unknown>>>({});
  const [sectionRefresh, setSectionRefresh] = useState(0);
  const [preferenceReset, setPreferenceReset] = useState(0);
  const [section, setSection] = useState<WorkspaceSection | undefined>(initialSection);
  const [isLoading, setLoading] = useState(true);
  const [isMutating, setMutating] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormDialog>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await chat.request('/api/native/workspace', { cache: 'no-store' });
      const value = await response.json() as WorkspaceData;
      setData(value);
      setError('');
      return value;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load the native workspace.');
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [chat.request]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!section) return;
    const controller = new AbortController();
    const slug = section === 'contextAwareness' ? 'context-awareness' : section;
    const load = async () => {
      const response = await chat.request(`/api/native/workspace/${slug}`, { cache: 'no-store', signal: controller.signal });
      const value = await response.json();
      if (section !== 'contextAwareness') return value;
      const to = Date.now(); const from = to - 31 * 24 * 60 * 60 * 1000;
      const historyResponse = await chat.request(`/api/native/workspace/context-awareness/history?from=${from}&to=${to}`, { cache: 'no-store', signal: controller.signal });
      return { ...object(value), history: await historyResponse.json() };
    };
    void load().then(value => setSectionData(current => ({ ...current, [section]: value }))).catch(() => undefined);
    return () => controller.abort();
  }, [chat.request, section, sectionRefresh]);

  useEffect(() => {
    if (form || isMutating) return;
    const interval = window.setInterval(() => { void refresh(); setSectionRefresh(current => current + 1); }, 15_000);
    return () => window.clearInterval(interval);
  }, [form, isMutating, refresh]);

  const read = useCallback(async (path: string) => {
    const response = await chat.request(`/api/native/workspace${path}`, { cache: 'no-store' });
    return response.json() as Promise<unknown>;
  }, [chat.request]);

  const mutate = useCallback(async ({ path, method = 'POST', body, success }: { path: string; method?: 'POST' | 'PATCH' | 'DELETE'; body?: JsonObject; success: string }) => {
    setMutating(true);
    try {
      await chat.request(`/api/native/workspace${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      notify(success, 'success');
      setForm(undefined);
      await refresh();
      setSectionRefresh(current => current + 1);
      if (path === '/preferences') window.dispatchEvent(new CustomEvent('aside:preferences-changed', { detail: body }));
      return true;
    } catch (reason) {
      if (path === '/preferences') {
        const preferences = await chat.request('/api/native/workspace/preferences', { cache: 'no-store' }).then(response => response.json()).catch(() => undefined);
        const workspace = await refresh();
        const latestPreferences = preferences ?? workspace?.sections.preferences;
        if (latestPreferences !== undefined) setSectionData(current => ({ ...current, preferences: latestPreferences }));
        if (errorStatus(reason) === 409) {
          window.dispatchEvent(new CustomEvent('aside:preferences-changed', { detail: { refresh: true } }));
          if (latestPreferences !== undefined) {
            setPreferenceReset(current => current + 1);
            notify('Preferences changed in Aside. Loaded the latest settings.', 'error');
          } else {
            notify('Preferences may have changed in Aside. Could not reload them yet.', 'error');
          }
          return false;
        }
        notify('Preferences were not saved. Your draft is still here.', 'error');
        return false;
      }
      notify('The change could not be saved.', 'error');
      return false;
    } finally {
      setMutating(false);
    }
  }, [chat.request, notify, refresh]);

  const availableSections = useMemo(() => SECTION_META.filter(item => data?.capabilities[item.id]), [data?.capabilities]);
  const selected = section && data?.capabilities[section] ? section : undefined;

  if (isLoading && !data) return <div role="status" {...stylex.props(styles.center)}><RefreshCw aria-hidden="true" size={20} strokeWidth={ICON_STROKE} /><span>Loading native workspace…</span></div>;
  if (error && !data) return <EmptyState icon={ShieldCheck} title="Workspace unavailable" detail={error} action={<Button onClick={() => void refresh()}>Try again</Button>} />;
  if (!data?.available) return <EmptyState icon={ShieldCheck} title="Native workspace unavailable" detail="Connect to a supported Aside profile to manage native settings." />;

  return <div {...stylex.props(styles.workspace)}>
    {selected ? <>
      <div {...stylex.props(styles.sectionHeader)}><button type="button" aria-label="Back to workspace" {...stylex.props(styles.back)} onClick={() => setSection(undefined)}><ChevronLeft size={22} strokeWidth={ICON_STROKE} aria-hidden="true" /></button><div><h2 {...stylex.props(styles.pageTitle)}>{SECTION_META.find(item => item.id === selected)?.title}</h2><p {...stylex.props(styles.pageDescription)}>{SECTION_META.find(item => item.id === selected)?.description}</p></div></div>
      <SectionContent section={selected} value={sectionData[selected] ?? data.sections[selected]} capabilities={data.capabilities} preferenceReset={preferenceReset} isMutating={isMutating} mutate={mutate} read={read} openForm={setForm} onOpenSession={onOpenSession} onNewProjectChat={onNewProjectChat} />
    </> : <>
      <div {...stylex.props(styles.overviewHeader)}><div><h2 {...stylex.props(styles.pageTitle)}>Workspace</h2><p {...stylex.props(styles.pageDescription)}>Settings stored by the connected Aside profile.</p></div></div>
      <div {...stylex.props(styles.grid)}>{availableSections.map(item => <SectionTile key={item.id} {...item} value={data.sections[item.id]} onClick={() => setSection(item.id)} />)}</div>
      {!availableSections.length ? <EmptyState icon={ShieldCheck} title="No native controls available" detail="This Aside version did not report any supported workspace capabilities." /> : undefined}
    </>}
    {form ? <EditDialog form={form} isSaving={isMutating} onClose={() => setForm(undefined)} /> : undefined}
  </div>;
}

function SectionTile({ title, description, icon: Icon, value, onClick }: { title: string; description: string; icon: LucideIcon; value: unknown; onClick: () => void }) {
  const count = itemArray(value).length;
  return <button type="button" {...stylex.props(styles.tile)} onClick={onClick}><span {...stylex.props(styles.tileIcon)}><Icon size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /></span><span {...stylex.props(styles.tileCopy)}><strong>{title}</strong><span {...stylex.props(ui.muted)}>{description}</span></span>{count ? <span {...stylex.props(styles.count)}>{count}</span> : undefined}</button>;
}

function SectionContent({ section, value, capabilities, preferenceReset, isMutating, mutate, read, openForm, onOpenSession, onNewProjectChat }: {
  section: WorkspaceSection;
  value: unknown;
  capabilities: WorkspaceData['capabilities'];
  preferenceReset: number;
  isMutating: boolean;
  mutate: (input: { path: string; method?: 'POST' | 'PATCH' | 'DELETE'; body?: JsonObject; success: string }) => Promise<boolean>;
  read: (path: string) => Promise<unknown>;
  openForm: (dialog: FormDialog) => void;
  onOpenSession?: (sessionId: string) => void;
  onNewProjectChat?: (projectId: string) => void;
}) {
  const props = { value, isMutating, mutate, read, openForm };
  if (section === 'projects') return <Projects {...props} canEditInstructions={Boolean(capabilities.projectInstructions)} onOpenSession={onOpenSession} onNewProjectChat={onNewProjectChat} />;
  if (section === 'routines') return <Routines {...props} />;
  if (section === 'memories') return <Memories {...props} />;
  if (section === 'contextAwareness') return <ContextAwareness {...props} />;
  if (section === 'skills') return <Skills {...props} canViewCatalog={Boolean(capabilities.skillCatalog)} canCustomize={Boolean(capabilities.skillCustomization)} />;
  if (section === 'connections') return <Connections {...props} canEditToolPermissions={Boolean(capabilities.toolPermissions)} />;
  if (section === 'providers') return <Providers {...props} />;
  if (section === 'account') return <Account {...props} />;
  return <Preferences key={preferenceReset} {...props} />;
}

function Projects({ value, isMutating, mutate, read, openForm, canEditInstructions, onOpenSession, onNewProjectChat }: SectionProps & { canEditInstructions: boolean; onOpenSession?: (sessionId: string) => void; onNewProjectChat?: (projectId: string) => void }) {
  const items = itemArray(value);
  return <SectionList title="Projects" actionLabel="New project" onAction={() => openForm(projectForm())} empty="No projects"><div {...stylex.props(styles.list)}>{items.map(item => {
    const id = itemId(item, 'projectId'); const isArchived = bool(item.archived) || Boolean(item.archivedAt);
    return <ResourceCard key={id} title={label(item)} detail={text(item.workspacePath) || text(item.workingDirectory) || text(item.path) || text(item.instructions)} badge={isArchived ? 'Archived' : undefined}>
      <CardActions><Button size="compact" onClick={() => openForm(projectForm(item, values => mutate({ path: `/projects/${encodeURIComponent(id)}`, method: 'PATCH', body: values, success: 'Project updated.' })))}>Edit</Button>{canEditInstructions ? <Button size="compact" onClick={() => void read(`/projects/${encodeURIComponent(id)}/instructions`).then(result => { const instructions = object(result); openForm({ title: `${label(item)} instructions`, description: 'Instructions saved as AGENTS.md in the project workspace.', submitLabel: 'Save instructions', fields: [{ key: 'content', label: 'Instructions', value: text(instructions.content), kind: 'textarea' }], onSubmit: values => mutate({ path: `/projects/${encodeURIComponent(id)}/instructions`, method: 'PATCH', body: { content: values.content }, success: 'Project instructions updated.' }) }); })}>Instructions</Button> : undefined}{onNewProjectChat && !isArchived ? <Button size="compact" variant="primary" onClick={() => onNewProjectChat(id)}>New chat</Button> : undefined}{text(item.sessionId) && onOpenSession ? <Button size="compact" onClick={() => onOpenSession(text(item.sessionId))}>Open chat</Button> : undefined}{!isArchived ? <Button size="compact" disabled={isMutating} onClick={() => void mutate({ path: `/projects/${encodeURIComponent(id)}/archive`, success: 'Project archived.' })}><Archive size={15} />Archive</Button> : undefined}<Button size="compact" variant="danger" disabled={isMutating} onClick={() => openForm(confirmForm('Delete project?', 'The project entry will be removed.', () => mutate({ path: `/projects/${encodeURIComponent(id)}`, method: 'DELETE', success: 'Project deleted.' })))}><Trash2 size={15} />Delete</Button></CardActions>
    </ResourceCard>;
  })}</div></SectionList>;

  function projectForm(item?: JsonObject, submit?: FormDialog['onSubmit']): FormDialog {
    return { title: item ? 'Edit project' : 'New project', description: 'Set the local working folder for this project.', submitLabel: item ? 'Save project' : 'Create project', fields: [
      { key: 'name', label: 'Name', value: text(item?.name) || text(item?.title), required: true },
      { key: 'workspacePath', label: 'Working directory', value: text(item?.workspacePath) || text(item?.workingDirectory) || text(item?.path), placeholder: '/Users/me/project', required: true },
    ], onSubmit: submit ?? (values => mutate({ path: '/projects', body: values, success: 'Project created.' })) };
  }
}

function Routines({ value, isMutating, mutate, read, openForm }: SectionProps) {
  const items = itemArray(value);
  const [histories, setHistories] = useState<Record<string, JsonObject[]>>({});
  return <SectionList title="Routines" actionLabel="New routine" onAction={() => openForm(routineForm())} empty="No routines"><div {...stylex.props(styles.list)}>{items.map(item => {
    const id = itemId(item, 'routineId'); const isPaused = bool(item.paused) || text(item.status) === 'paused';
    return <ResourceCard key={id} title={label(item)} detail={[text(item.schedule), text(item.lastRunAt) ? `Last run ${dateText(item.lastRunAt)}` : ''].filter(Boolean).join(' · ')} badge={isPaused ? 'Paused' : text(item.status)}>
      {text(item.prompt) ? <p {...stylex.props(styles.body)}>{text(item.prompt)}</p> : undefined}
      <CardActions><Button size="compact" onClick={() => openForm(routineForm(item))}>Edit</Button><Button size="compact" disabled={isMutating} onClick={() => void mutate({ path: `/routines/${encodeURIComponent(id)}/run`, success: 'Routine started.' })}><Play size={15} />Run now</Button><Button size="compact" disabled={isMutating} onClick={() => void mutate({ path: `/routines/${encodeURIComponent(id)}/${isPaused ? 'resume' : 'pause'}`, success: isPaused ? 'Routine resumed.' : 'Routine paused.' })}>{isPaused ? <Play size={15} /> : <Pause size={15} />}{isPaused ? 'Resume' : 'Pause'}</Button><Button size="compact" onClick={() => void read(`/routines/${encodeURIComponent(id)}/history`).then(result => setHistories(current => ({ ...current, [id]: itemArray(result) })))}><History size={15} />History</Button><Button size="compact" variant="danger" onClick={() => openForm(confirmForm('Delete routine?', 'Its run history will no longer be available here.', () => mutate({ path: `/routines/${encodeURIComponent(id)}`, method: 'DELETE', success: 'Routine deleted.' })))}>Delete</Button></CardActions>
      {histories[id] ? <div {...stylex.props(styles.history)}>{histories[id].length ? histories[id].map(run => <div key={itemId(run)} {...stylex.props(styles.historyRow)}><span>{label(run)}</span><span {...stylex.props(ui.muted)}>{dateText(run.updatedAt) || text(run.status)}</span></div>) : <span {...stylex.props(ui.muted)}>No runs yet.</span>}</div> : undefined}
    </ResourceCard>;
  })}</div></SectionList>;

  function routineForm(item?: JsonObject): FormDialog {
    const config = object(item?.sessionConfig); const model = object(config.model);
    return { title: item ? 'Edit routine' : 'New routine', description: 'Schedule a prompt using the connected Aside profile.', submitLabel: item ? 'Save routine' : 'Create routine', fields: [
      { key: 'name', label: 'Name', value: text(item?.name) || text(item?.title), required: true }, { key: 'prompt', label: 'Prompt', value: text(item?.prompt), kind: 'textarea', required: true }, { key: 'rrule', label: 'Schedule rule', value: text(item?.rrule) || text(item?.schedule), placeholder: 'FREQ=DAILY;BYHOUR=9', required: true }, ...(item ? [] : [
        { key: 'environment', label: 'Run on', value: 'device', kind: 'select' as const, options: [{ value: 'device', label: 'This device' }, { value: 'cloud', label: 'Cloud' }] },
        { key: 'modelProvider', label: 'Model provider', value: text(model.provider) || 'openai-codex', required: true }, { key: 'modelId', label: 'Model', value: text(model.modelId) || 'gpt-6.1-sol', required: true }, { key: 'thinkingLevel', label: 'Thinking level', value: text(model.thinkingLevel) || 'high' }, { key: 'permissionMode', label: 'Permission', value: text(config.permissionMode) || 'guard' }, { key: 'notificationsEnabled', label: 'Notify when finished', value: true, kind: 'checkbox' as const },
      ]),
    ], onSubmit: values => item ? mutate({ path: `/routines/${encodeURIComponent(itemId(item, 'routineId'))}`, method: 'PATCH', body: { name: values.name, prompt: values.prompt, rrule: values.rrule }, success: 'Routine updated.' }) : mutate({ path: '/routines', body: { name: values.name, prompt: values.prompt, rrule: values.rrule, environment: values.environment, sessionConfig: { model: { provider: values.modelProvider, modelId: values.modelId, thinkingLevel: values.thinkingLevel, fastMode: false }, permissionMode: values.permissionMode, notificationsEnabled: values.notificationsEnabled } }, success: 'Routine created.' }) };
  }
}

function Memories({ value, isMutating, mutate, read, openForm }: SectionProps) {
  const root = object(value); const items = itemArray(root.items ?? root.files ?? value); const preferences = object(root.preferences);
  const editMemory = async (item: JsonObject) => {
    const path = text(item.path);
    const result = await read(`/memories/file?path=${encodeURIComponent(path)}`);
    const memory = object(result);
    openForm({
      title: 'Edit memory', description: path, submitLabel: 'Save memory',
      fields: [{ key: 'content', label: 'Memory', value: text(memory.content) || text(result), kind: 'textarea', required: true }],
      onSubmit: values => mutate({ path: '/memories/file', method: 'PATCH', body: { path, content: values.content }, success: 'Memory updated.' }),
    });
  };
  const editPreferences = () => openForm({
    title: 'Memory preferences', description: 'Choose how long Aside keeps generated memories.', submitLabel: 'Save preferences',
    fields: [{ key: 'enabled', label: 'Use memory', value: bool(preferences.enabled), kind: 'checkbox' }, { key: 'episodicRetentionDays', label: 'Retention days', value: text(preferences.episodicRetentionDays), kind: 'number', placeholder: '90' }, { key: 'dreamingMinHours', label: 'Minimum hours before memory generation', value: text(preferences.dreamingMinHours), kind: 'number' }, { key: 'dreamingMinSessions', label: 'Minimum sessions before memory generation', value: text(preferences.dreamingMinSessions), kind: 'number' }],
    onSubmit: values => mutate({ path: '/memories/preferences', method: 'PATCH', body: { enabled: values.enabled, episodicRetentionDays: numeric(values.episodicRetentionDays), dreamingMinHours: numeric(values.dreamingMinHours), dreamingMinSessions: numeric(values.dreamingMinSessions) }, success: 'Memory preferences updated.' }),
  });
  return <SectionList title="Memory" actionLabel="Retention" onAction={editPreferences} empty="No saved memories"><div {...stylex.props(styles.list)}>{items.map(item => { const path = text(item.path); return <ResourceCard key={itemId(item, 'path')} title={label(item)} detail={[path, dateText(item.lastUpdatedAt)].filter(Boolean).join(' · ')}><CardActions><Button size="compact" onClick={() => void editMemory(item)}>Edit</Button></CardActions></ResourceCard>; })}</div></SectionList>;
}

function ContextAwareness({ value, isMutating, mutate, openForm }: SectionProps) {
  const state = object(value); const settings = object(state.settings); const status = object(state.status); const history = itemArray(state.history);
  const [optimistic, setOptimistic] = useState(() => ({ enabled: bool(settings.enabled), captureTypedText: bool(settings.captureTypedText), screenOcr: bool(settings.screenOcr), pausedUntil: Number(settings.pausedUntil) || 0 }));
  useEffect(() => { setOptimistic({ enabled: bool(settings.enabled), captureTypedText: bool(settings.captureTypedText), screenOcr: bool(settings.screenOcr), pausedUntil: Number(settings.pausedUntil) || 0 }); }, [settings.enabled, settings.captureTypedText, settings.screenOcr, settings.pausedUntil]);
  const isPaused = optimistic.pausedUntil > Date.now();
  const update = async (key: keyof typeof optimistic, next: boolean | number, success: string) => {
    const previous = optimistic[key]; setOptimistic(current => ({ ...current, [key]: next }));
    const didSave = await mutate({ path: '/context-awareness', method: 'PATCH', body: { [key]: key === 'pausedUntil' && next === 0 ? null : next }, success });
    if (!didSave) setOptimistic(current => ({ ...current, [key]: previous }));
  };
  return <div {...stylex.props(styles.stack)}><ResourceCard title="Capture controls" detail={text(status.state) ? `Status: ${text(status.state)}` : 'Nothing is enabled automatically. You control capture and exclusions.'}><SwitchRow label="Context awareness" detail="Allow supported native context capture" checked={optimistic.enabled} disabled={isMutating} onChange={enabled => void update('enabled', enabled, enabled ? 'Context awareness enabled.' : 'Context awareness disabled.')} /><SwitchRow label="Pause capture for 24 hours" detail="Temporarily stop new captures" checked={isPaused} disabled={isMutating || !optimistic.enabled} onChange={paused => void update('pausedUntil', paused ? Date.now() + 86_400_000 : 0, paused ? 'Capture paused.' : 'Capture resumed.')} /><SwitchRow label="Capture typed text" checked={optimistic.captureTypedText} disabled={isMutating || !optimistic.enabled} onChange={captureTypedText => void update('captureTypedText', captureTypedText, 'Typed-text capture updated.')} /><SwitchRow label="Screen text recognition" checked={optimistic.screenOcr} disabled={isMutating || !optimistic.enabled} onChange={screenOcr => void update('screenOcr', screenOcr, 'Screen text recognition updated.')} /><CardActions><Button size="compact" onClick={() => openForm({ title: 'Excluded apps and sites', description: 'Enter app:com.example.App or site:example.com on separate lines.', submitLabel: 'Save exclusions', fields: [{ key: 'rules', label: 'Exclusions', value: ruleList(settings.rules).join('\n'), kind: 'textarea' }], onSubmit: values => mutate({ path: '/context-awareness', method: 'PATCH', body: { rules: String(values.rules).split('\n').map(pattern => pattern.trim()).filter(Boolean).map(pattern => contextRule(pattern)) }, success: 'Exclusions updated.' }) })}>Edit exclusions</Button></CardActions></ResourceCard><SectionList title="Capture history" empty="No capture history"><div {...stylex.props(styles.list)}>{history.map(item => <ResourceCard key={itemId(item)} title={label(item)} detail={[text(item.application), text(item.url), dateText(item.createdAt)].filter(Boolean).join(' · ')} />)}</div>{history.length ? <CardActions><Button size="compact" variant="danger" onClick={() => openForm(confirmForm('Clear capture history?', 'Previously captured context will be removed from history.', () => mutate({ path: '/context-awareness/history', method: 'DELETE', body: { target: { kind: 'all' } }, success: 'Capture history cleared.' })))}>Clear history</Button></CardActions> : undefined}</SectionList></div>;
}

function Skills({ value, isMutating, mutate, read, openForm, canViewCatalog, canCustomize }: SectionProps & { canViewCatalog: boolean; canCustomize: boolean }) {
  const items = itemArray(value);
  const [catalog, setCatalog] = useState<JsonObject>();
  useEffect(() => { if (canViewCatalog) void read('/skills/catalog').then(result => setCatalog(object(result))).catch(() => undefined); }, [canViewCatalog, read]);
  const editSkill = async (item: JsonObject) => {
    const path = text(item.path) || text(item.skillPath) || itemId(item); const projectId = text(item.projectId);
    const result = await read(`/skills/${encodeURIComponent(path)}${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`);
    openForm(skillForm({ ...item, ...object(result) }));
  };
  return <SectionList title="Skills" actionLabel="Add skill" onAction={() => openForm(skillForm())} secondaryAction={<Button size="compact" onClick={() => openForm({ title: 'Import skill', description: 'Import a skill from a local folder.', submitLabel: 'Import', fields: [{ key: 'sourcePath', label: 'Source folder', placeholder: '/Users/me/skill', required: true }, { key: 'projectId', label: 'Project ID (optional)' }], onSubmit: values => mutate({ path: '/skills/import', body: values, success: 'Skill imported.' }) })}>Import</Button>} empty="No skills"><div {...stylex.props(styles.list)}>{items.map(item => {
    const path = text(item.path) || text(item.skillPath) || itemId(item); const isWritable = text(item.group) === 'user' || bool(item.writable);
    return <ResourceCard key={path} title={label(item)} detail={path} badge={bool(item.enabled) ? 'Enabled' : undefined}><p {...stylex.props(styles.body)}>{text(item.description)}</p><CardActions>{isWritable ? <><Button size="compact" onClick={() => void editSkill(item)}>Edit</Button><Button size="compact" variant="danger" disabled={isMutating} onClick={() => openForm(confirmForm('Delete skill?', 'The selected skill will be removed.', () => mutate({ path: `/skills/${encodeURIComponent(path)}`, method: 'DELETE', success: 'Skill deleted.' })))}>Delete</Button></> : canCustomize ? <Button size="compact" disabled={isMutating} onClick={() => void mutate({ path: `/skills/${encodeURIComponent(path)}/copy`, body: { projectId: item.projectId ?? null }, success: 'Skill copied for customization.' })}>Customize</Button> : undefined}</CardActions></ResourceCard>;
  })}</div>{catalog ? <div {...stylex.props(styles.catalog)}><h4 {...stylex.props(styles.listTitle)}>Local catalog</h4>{Object.entries(object(catalog.groups)).map(([group, skills]) => { const entries = itemArray(skills); return <div key={group} {...stylex.props(styles.catalogGroup)}><div {...stylex.props(styles.catalogRow)}><span>{humanize(group)}</span><span {...stylex.props(ui.muted)}>{entries.length}</span></div>{entries.length ? <div {...stylex.props(styles.chips)}>{entries.map(skill => <span key={itemId(skill)} {...stylex.props(styles.chip)}>{label(skill)}</span>)}</div> : undefined}</div>; })}</div> : undefined}</SectionList>;

  function skillForm(item?: JsonObject): FormDialog {
    const path = item ? text(item.path) || text(item.skillPath) || itemId(item) : '';
    const autoInject = object(object(item?.metadata).autoInject);
    return { title: item ? 'Edit skill' : 'Create skill', description: 'Skills add reusable instructions to Aside.', submitLabel: item ? 'Save skill' : 'Create skill', fields: [{ key: 'name', label: 'Name', value: text(item?.name), required: true }, { key: 'description', label: 'Description', value: text(item?.description), required: true }, { key: 'body', label: 'Instructions', value: text(item?.body) || text(item?.content), kind: 'textarea', required: true }, { key: 'keywords', label: 'Keywords', value: stringList(item?.keywords ?? autoInject.keywords).join(', '), placeholder: 'research, writing' }, { key: 'urlPatterns', label: 'URL patterns', value: stringList(item?.urlPatterns ?? autoInject.url).join('\n'), kind: 'textarea' }, { key: 'enabled', label: 'Enabled', value: item ? bool(item.enabled) : true, kind: 'checkbox' }], onSubmit: values => {
      const body = { name: values.name, description: values.description, body: values.body, enabled: values.enabled, keywords: stringList(values.keywords), urlPatterns: stringList(values.urlPatterns) };
      return mutate({ path: item ? `/skills/${encodeURIComponent(path)}` : '/skills', method: item ? 'PATCH' : 'POST', body, success: item ? 'Skill updated.' : 'Skill created.' });
    } };
  }
}

function Connections({ value, isMutating, mutate, read, openForm, canEditToolPermissions }: SectionProps & { canEditToolPermissions: boolean }) {
  const root = object(value); const items = itemArray(root.servers ?? value); const inventories = object(root.inventories);
  const [toolPolicies, setToolPolicies] = useState<{ tools: JsonObject[]; policies: Record<string, string> }>({ tools: [], policies: {} });
  useEffect(() => { if (canEditToolPermissions) void read('/connections/tools/permissions').then(result => { const permission = object(result); setToolPolicies({ tools: toolArray(permission.tools), policies: permissionPolicies(permission.rules) }); }).catch(() => undefined); }, [canEditToolPermissions, read]);
  const updateToolPolicy = async (tool: string, policy: string) => {
    const previous = toolPolicies.policies[tool] ?? 'inherit'; setToolPolicies(current => ({ ...current, policies: { ...current.policies, [tool]: policy } }));
    const didSave = await mutate({ path: '/connections/tools/permissions', method: 'PATCH', body: { tool, policy }, success: 'Tool permission updated.' });
    if (!didSave) setToolPolicies(current => ({ ...current, policies: { ...current.policies, [tool]: previous } }));
  };
  return <div {...stylex.props(styles.stack)}><SectionList title="Plugins & MCP" actionLabel="New connection" onAction={() => openForm(connectionForm())} empty="No connections"><div {...stylex.props(styles.list)}>{items.map(item => {
    const name = text(item.name) || itemId(item); const isConnected = bool(item.connected) || text(item.status) === 'connected';
    return <ResourceCard key={name} title={label(item)} detail={text(item.url) || text(item.command)} badge={text(item.status)}><CardActions><Button size="compact" onClick={() => openForm(connectionForm(item))}>Edit</Button><Button size="compact" disabled={isMutating} onClick={() => void mutate({ path: `/connections/${encodeURIComponent(name)}/test`, success: 'Connection test finished.' })}>Test</Button><Button size="compact" disabled={isMutating} onClick={() => void mutate({ path: `/connections/${encodeURIComponent(name)}/${isConnected ? 'cancel' : 'connect'}`, success: isConnected ? 'Connection disconnected.' : 'Connection started.' })}>{isConnected ? 'Disconnect' : 'Connect'}</Button><Button size="compact" variant="danger" onClick={() => openForm(confirmForm('Delete connection?', 'The connection configuration will be removed.', () => mutate({ path: `/connections/${encodeURIComponent(name)}`, method: 'DELETE', success: 'Connection deleted.' })))}>Delete</Button></CardActions></ResourceCard>;
  })}</div></SectionList>{toolPolicies.tools.length ? <SectionList title="Tool permissions" empty="No tools"><div {...stylex.props(styles.list)}>{toolPolicies.tools.map(tool => { const name = text(tool.name) || text(tool.id) || itemId(tool); return <div key={name} {...stylex.props(styles.permissionRow)}><span {...stylex.props(styles.cardCopy)}><strong>{label(tool)}</strong>{text(tool.description) ? <span {...stylex.props(ui.muted)}>{text(tool.description)}</span> : undefined}</span><select aria-label={`${label(tool)} permission`} value={toolPolicies.policies[name] ?? 'inherit'} disabled={isMutating} {...stylex.props(styles.compactSelect)} onChange={event => void updateToolPolicy(name, event.target.value)}><option value="inherit">Default</option><option value="allow">Allow</option><option value="ask">Ask</option><option value="deny">Deny</option></select></div>; })}</div></SectionList> : undefined}{Object.keys(inventories).length ? <SectionList title="Available tools" empty="No tools"><div {...stylex.props(styles.list)}>{Object.entries(inventories).map(([name, inventory]) => { const tools = itemArray(object(inventory).tools); return <ResourceCard key={name} title={name} detail={`${tools.length} tool${tools.length === 1 ? '' : 's'}`}>{tools.length ? <p {...stylex.props(styles.body)}>{tools.map(tool => label(tool)).join(', ')}</p> : undefined}</ResourceCard>; })}</div></SectionList> : undefined}</div>;

  function connectionForm(item?: JsonObject): FormDialog {
    const server = object(item?.server ?? item);
    return { title: item ? 'Edit connection' : 'New connection', description: 'Connect a local command or an HTTP MCP server. Credentials are never displayed after saving.', submitLabel: item ? 'Save connection' : 'Create connection', fields: [{ key: 'name', label: 'Name', value: text(item?.name), required: true }, { key: 'transport', label: 'Transport', value: text(server.transport) || 'streamable-http', kind: 'select', options: [{ value: 'streamable-http', label: 'HTTP' }, { value: 'stdio', label: 'Local command' }] }, { key: 'url', label: 'Server URL', value: text(server.url), placeholder: 'https://…' }, { key: 'command', label: 'Local command', value: text(server.command) }, { key: 'args', label: 'Command arguments', value: stringList(server.args).join(' '), placeholder: '--flag value' }, { key: 'clientSecret', label: 'Client secret (optional)', kind: 'password' }, { key: 'enabled', label: 'Enabled', value: item ? bool(item.enabled) : true, kind: 'checkbox' }], onSubmit: values => {
      const transport = String(values.transport); const serverValue = transport === 'stdio' ? { enabled: Boolean(values.enabled), transport, command: String(values.command), args: String(values.args).split(/\s+/).filter(Boolean), env: {} } : { enabled: Boolean(values.enabled), transport, url: String(values.url), auth: { type: values.clientSecret ? 'auto' : 'none' } };
      return mutate({ path: item ? `/connections/${encodeURIComponent(text(item.name))}` : '/connections', method: item ? 'PATCH' : 'POST', body: { name: values.name, server: serverValue, ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}) }, success: item ? 'Connection updated.' : 'Connection created.' });
    } };
  }
}

function Providers({ value, isMutating, mutate, openForm }: SectionProps) {
  const root = object(value); const connections = itemArray(root.connectedProviders); const models = itemArray(root.availableModels); const connectionById = new Map(connections.map(item => [text(item.providerId), item])); const providerIds = [...new Set([...connections.map(item => text(item.providerId)), ...models.map(item => text(item.provider)).filter(Boolean)])];
  return <SectionList title="AI providers" actionLabel="Custom provider" onAction={() => openForm({ title: 'Add custom provider', description: 'Credentials are write-only and are never returned by the server.', submitLabel: 'Add provider', fields: [{ key: 'id', label: 'Provider ID', required: true }, { key: 'name', label: 'Display name', required: true }, { key: 'baseUrl', label: 'API base URL', placeholder: 'https://…', required: true }, { key: 'modelId', label: 'Model ID', required: true }, { key: 'apiKey', label: 'API key', kind: 'password', required: true }], onSubmit: values => mutate({ path: '/providers/custom', body: { providers: { [String(values.id)]: { name: values.name, api: 'openai-completions', baseUrl: values.baseUrl, apiKey: values.apiKey, authHeader: 'Authorization', models: [{ id: values.modelId, name: values.modelId }] } } }, success: 'Provider added.' }) })} empty="No providers"><div {...stylex.props(styles.list)}>{providerIds.map(id => {
    const connection = connectionById.get(id); const providerModels = models.filter(model => text(model.provider) === id); const isCustom = text(connection?.type) === 'custom'; const canEditApiKey = text(connection?.credentialType) === 'api_key' || text(connection?.type) === 'api_key';
    return <ResourceCard key={id} title={text(connection?.name) || id} detail={providerModels.length ? `${providerModels.length} model${providerModels.length === 1 ? '' : 's'}` : id} badge={connection ? text(connection.state) || 'Connected' : 'Available'}><CardActions>{canEditApiKey ? <Button size="compact" onClick={() => openForm({ title: `Update ${id} credential`, description: 'The credential is sent once and will not be shown again.', submitLabel: 'Save credential', fields: [{ key: 'credential', label: 'API key', kind: 'password', required: true }], onSubmit: values => mutate({ path: `/providers/${encodeURIComponent(id)}/credential`, body: { credential: { type: 'api_key', key: values.credential } }, success: 'Credential updated.' }) })}><KeyRound size={15} />Credential</Button> : undefined}{isCustom ? <Button size="compact" variant="danger" disabled={isMutating} onClick={() => openForm(confirmForm('Delete provider?', 'The custom provider configuration will be removed.', () => mutate({ path: `/providers/custom/${encodeURIComponent(id)}`, method: 'DELETE', success: 'Provider deleted.' })))}>Delete</Button> : undefined}</CardActions></ResourceCard>;
  })}</div></SectionList>;
}

function Account({ value, isMutating, mutate, openForm }: SectionProps) {
  const root = object(value); const profile = object(root.profile); const devices = itemArray(root.devices);
  return <div {...stylex.props(styles.stack)}><ResourceCard title={text(profile.name) || text(profile.email) || 'Account'} detail={text(profile.email) || text(profile.provider)} badge={text(profile.subscriptionPlan)}><CardActions><Button size="compact" onClick={() => openForm({ title: 'Edit profile', description: 'Update the display name for the connected Aside account.', submitLabel: 'Save profile', fields: [{ key: 'name', label: 'Display name', value: text(profile.name), required: true }], onSubmit: values => mutate({ path: '/account/profile', method: 'PATCH', body: values, success: 'Profile updated.' }) })}>Edit profile</Button></CardActions></ResourceCard><SectionList title="Active devices" empty="No devices"><div {...stylex.props(styles.list)}>{devices.map(item => {
    const id = text(item.deviceId) || itemId(item);
    return <ResourceCard key={id} title={text(item.deviceName) || label(item)} detail={[text(item.platform), text(item.appVersion), dateText(item.lastSeenAt)].filter(Boolean).join(' · ')} badge={bool(item.isCurrent) ? 'This device' : undefined}>{!bool(item.isCurrent) ? <CardActions><Button size="compact" variant="danger" disabled={isMutating} onClick={() => void mutate({ path: `/account/devices/${encodeURIComponent(id)}/sign-out`, success: 'Device signed out.' })}>Sign out</Button></CardActions> : undefined}</ResourceCard>;
  })}</div></SectionList></div>;
}

function Preferences({ value, isMutating, mutate }: Omit<SectionProps, 'openForm'>) {
  const state = object(value);
  const tabs = object(state.agentTabs); const taskNotifications = object(state.agentTaskNotifications); const sound = object(state.completionSound);
  const [draft, setDraft] = useState(() => ({ defaultPermissionMode: text(state.defaultPermissionMode) || 'default', followUpBehavior: text(state.followUpBehavior) || 'queue', tabCleanupMinutes: text(tabs.closeAfterIdleMinutes) || 'never', sidebarRecentChatLimit: text(state.sidebarRecentChatLimit) || '3', needsAttention: bool(taskNotifications.needsAttention), taskCompletions: bool(taskNotifications.taskCompletions), routineCompletions: bool(taskNotifications.routineCompletions), completionSound: bool(sound.enabled), sidepanelSessionOnTabChange: text(state.sidepanelSessionOnTabChange) || 'new-session', timezone: text(state.timezone) }));
  return <form {...stylex.props(styles.formCard)} onSubmit={event => { event.preventDefault(); void mutate({ path: '/preferences', method: 'PATCH', body: { defaultPermissionMode: draft.defaultPermissionMode, followUpBehavior: draft.followUpBehavior, agentTabs: { closeAfterIdleMinutes: draft.tabCleanupMinutes === 'never' ? null : Number(draft.tabCleanupMinutes) }, agentTaskNotifications: { needsAttention: draft.needsAttention, taskCompletions: draft.taskCompletions, routineCompletions: draft.routineCompletions }, completionSound: { enabled: draft.completionSound }, sidebarRecentChatLimit: Number(draft.sidebarRecentChatLimit), sidepanelSessionOnTabChange: draft.sidepanelSessionOnTabChange, timezone: draft.timezone }, success: 'Native preferences updated.' }); }}><Field label="Default permission"><select value={draft.defaultPermissionMode} {...stylex.props(ui.field)} onChange={event => setDraft(current => ({ ...current, defaultPermissionMode: event.target.value }))}><option value="default">Ask when needed</option><option value="full-access">Full access</option><option value="read-only">Read only</option></select></Field><Field label="Follow-up behavior"><select value={draft.followUpBehavior} {...stylex.props(ui.field)} onChange={event => setDraft(current => ({ ...current, followUpBehavior: event.target.value }))}><option value="queue">Queue</option><option value="steer">Steer</option></select></Field><Field label="Clean up agent tabs"><select value={draft.tabCleanupMinutes} {...stylex.props(ui.field)} onChange={event => setDraft(current => ({ ...current, tabCleanupMinutes: event.target.value }))}><option value="never">Never</option><option value="5">After 5 minutes</option><option value="10">After 10 minutes</option><option value="30">After 30 minutes</option><option value="60">After 1 hour</option></select></Field><Field label="Recent chats in sidebar"><input type="number" min="1" max="50" value={draft.sidebarRecentChatLimit} {...stylex.props(ui.field)} onChange={event => setDraft(current => ({ ...current, sidebarRecentChatLimit: event.target.value }))} /></Field><Field label="Sidebar when browser tab changes"><select value={draft.sidepanelSessionOnTabChange} {...stylex.props(ui.field)} onChange={event => setDraft(current => ({ ...current, sidepanelSessionOnTabChange: event.target.value }))}><option value="new-session">Start a new session</option><option value="keep-session">Keep current session</option></select></Field><Field label="Timezone"><input value={draft.timezone} placeholder="Asia/Seoul" {...stylex.props(ui.field)} onChange={event => setDraft(current => ({ ...current, timezone: event.target.value }))} /></Field><SwitchRow label="Needs-attention notifications" checked={draft.needsAttention} onChange={needsAttention => setDraft(current => ({ ...current, needsAttention }))} /><SwitchRow label="Task completion notifications" checked={draft.taskCompletions} onChange={taskCompletions => setDraft(current => ({ ...current, taskCompletions }))} /><SwitchRow label="Routine completion notifications" checked={draft.routineCompletions} onChange={routineCompletions => setDraft(current => ({ ...current, routineCompletions }))} /><SwitchRow label="Completion sound" checked={draft.completionSound} onChange={completionSound => setDraft(current => ({ ...current, completionSound }))} /><Button type="submit" variant="primary" disabled={isMutating}><Save size={16} />{isMutating ? 'Saving…' : 'Save preferences'}</Button></form>;
}

type SectionProps = {
  value: unknown;
  isMutating: boolean;
  mutate: (input: { path: string; method?: 'POST' | 'PATCH' | 'DELETE'; body?: JsonObject; success: string }) => Promise<boolean>;
  read: (path: string) => Promise<unknown>;
  openForm: (dialog: FormDialog) => void;
};

function SectionList({ title, actionLabel, onAction, secondaryAction, empty, children }: { title: string; actionLabel?: string; onAction?: () => void; secondaryAction?: React.ReactNode; empty: string; children?: React.ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <section><div {...stylex.props(styles.listHeader)}><h3 {...stylex.props(styles.listTitle)}>{title}</h3><div {...stylex.props(styles.inlineActions)}>{secondaryAction}{actionLabel && onAction ? <Button size="compact" variant="primary" onClick={onAction}><Plus size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />{actionLabel}</Button> : undefined}</div></div>{hasChildren ? children : <p {...stylex.props(styles.empty)}>{empty}</p>}</section>;
}

function ResourceCard({ title, detail, badge, children }: { title: string; detail?: string; badge?: string; children?: React.ReactNode }) {
  return <article {...stylex.props(styles.card)}><div {...stylex.props(styles.cardHeader)}><div {...stylex.props(styles.cardCopy)}><h4 {...stylex.props(styles.cardTitle)}>{title}</h4>{detail ? <p {...stylex.props(styles.detail)}>{detail}</p> : undefined}</div>{badge ? <span {...stylex.props(styles.badge)}>{badge}</span> : undefined}</div>{children}</article>;
}

function CardActions({ children }: { children: React.ReactNode }) { return <div {...stylex.props(styles.cardActions)}>{children}</div>; }

function SwitchRow({ label, detail, checked, disabled, onChange }: { label: string; detail?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label {...stylex.props(styles.switchRow)}><span {...stylex.props(styles.switchCopy)}><span>{label}</span>{detail ? <span {...stylex.props(ui.muted)}>{detail}</span> : undefined}</span><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} {...stylex.props(styles.switchInput)} /></label>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label {...stylex.props(styles.field)}><span>{label}</span>{children}</label>; }

function EditDialog({ form, isSaving, onClose }: { form: FormDialog; isSaving: boolean; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(form.fields.map(field => [field.key, field.value ?? (field.kind === 'checkbox' ? false : '')])));
  return <Dialog title={form.title} onClose={onClose}><DialogDescription>{form.description}</DialogDescription><form onSubmit={event => { event.preventDefault(); void form.onSubmit(values).catch(() => undefined); }}><div {...stylex.props(styles.dialogFields)}>{form.fields.map(field => field.kind === 'checkbox' ? <SwitchRow key={field.key} label={field.label} checked={Boolean(values[field.key])} onChange={checked => setValues(current => ({ ...current, [field.key]: checked }))} /> : <Field key={field.key} label={field.label}>{field.kind === 'textarea' ? <textarea required={field.required} rows={5} value={String(values[field.key] ?? '')} placeholder={field.placeholder} {...stylex.props(ui.field, styles.textarea)} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} /> : field.kind === 'select' ? <select required={field.required} value={String(values[field.key] ?? '')} {...stylex.props(ui.field)} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input required={field.required} type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'} value={String(values[field.key] ?? '')} placeholder={field.placeholder} autoComplete={field.kind === 'password' ? 'new-password' : 'off'} {...stylex.props(ui.field)} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} />}</Field>)}</div><DialogActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant={form.danger ? 'danger' : 'primary'} disabled={isSaving}>{isSaving ? 'Saving…' : form.submitLabel}</Button></DialogActions></form></Dialog>;
}

function EmptyState({ icon: Icon, title, detail, action }: { icon: LucideIcon; title: string; detail: string; action?: React.ReactNode }) { return <div {...stylex.props(styles.emptyState)}><Icon size={28} strokeWidth={ICON_STROKE} aria-hidden="true" /><strong>{title}</strong><p {...stylex.props(ui.muted)}>{detail}</p>{action}</div>; }

function confirmForm(title: string, description: string, onSubmit: () => Promise<unknown>): FormDialog { return { title, description, submitLabel: 'Delete', danger: true, fields: [], onSubmit }; }
function object(value: unknown): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
function itemArray(value: unknown): JsonObject[] { const source = Array.isArray(value) ? value : object(value).items; return Array.isArray(source) ? source.filter(item => item && typeof item === 'object').map(item => item as JsonObject) : []; }
function toolArray(value: unknown): JsonObject[] { return Array.isArray(value) ? value.map(item => typeof item === 'string' ? { name: item } : object(item)).filter(item => Object.keys(item).length) : []; }
function text(value: unknown) { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
function bool(value: unknown) { return value === true; }
function stringList(value: unknown) { return Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : typeof value === 'string' ? value.split(/[,\n]/).map(item => item.trim()).filter(Boolean) : []; }
function ruleList(value: unknown) { return Array.isArray(value) ? value.map(item => { const rule = object(item); return typeof item === 'string' ? item : text(rule.bundleId) ? `app:${text(rule.bundleId)}` : text(rule.urlDomain) ? `site:${text(rule.urlDomain)}` : ''; }).filter(Boolean) : []; }
function contextRule(pattern: string): JsonObject { if (pattern.startsWith('app:')) return { scope: 'app', bundleId: pattern.slice(4), behavior: 'do_not_observe' }; const domain = pattern.replace(/^site:/, '').replace(/^https?:\/\//, '').split('/')[0]; return { scope: 'url', urlDomain: domain, behavior: 'do_not_observe' }; }
function itemId(item: JsonObject, preferred = 'id') { return text(item[preferred]) || text(item.id) || text(item.path) || text(item.name) || JSON.stringify(item); }
function label(item: JsonObject) { return text(item.name) || text(item.title) || text(item.label) || text(item.filename) || itemId(item); }
function dateText(value: unknown) { const raw = text(value); if (!raw) return ''; const date = new Date(raw); return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
function numeric(value: string | boolean) { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
function errorStatus(value: unknown) {
  if (!value || typeof value !== 'object' || !('status' in value)) return undefined;
  return typeof value.status === 'number' ? value.status : undefined;
}
function humanize(value: string) { return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, character => character.toUpperCase()); }
function permissionPolicies(value: unknown) {
  if (Array.isArray(value)) return Object.fromEntries(value.map(item => { const rule = object(item); return [text(rule.tool) || text(rule.name), text(rule.policy) || 'inherit']; }).filter(([name]) => name));
  const rules = object(value); const policies: Record<string, string> = {};
  for (const policy of ['allow', 'ask', 'deny']) for (const item of itemArray(rules[policy])) { const tool = text(item.tool); if (tool) policies[tool] = policy; }
  return policies;
}

const styles = stylex.create({
  workspace: { display: 'flex', flexDirection: 'column', minHeight: 0, gap: 20, padding: '0 2px 24px', color: tokens.text },
  center: { minHeight: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: tokens.muted },
  overviewHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 10 },
  back: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 44, height: 44, padding: 0, borderWidth: 0, borderRadius: '50%', backgroundColor: { default: tokens.surface, ':hover': tokens.hover }, color: tokens.text },
  pageTitle: { fontSize: '1.125rem', fontWeight: 650, lineHeight: 1.3, margin: 0 },
  pageDescription: { margin: '3px 0 0', color: tokens.muted, fontSize: '.8125rem', lineHeight: 1.5 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, '@media (max-width: 520px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
  tile: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, minHeight: 82, padding: 14, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 18, backgroundColor: { default: tokens.surface, ':hover': tokens.hover }, color: tokens.text, textAlign: 'left' },
  tileIcon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 38, height: 38, borderRadius: 12, backgroundColor: tokens.hover, color: tokens.primary },
  tileCopy: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 2, overflowWrap: 'anywhere' },
  count: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, minWidth: 24, height: 24, padding: '0 7px', borderRadius: 12, backgroundColor: tokens.hover, color: tokens.muted, fontSize: '.75rem', lineHeight: 1, fontVariantNumeric: 'tabular-nums' },
  stack: { display: 'flex', flexDirection: 'column', gap: 20 },
  listHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  listTitle: { margin: 0, fontSize: '.875rem', fontWeight: 650 },
  inlineActions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { padding: 24, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens.border, borderRadius: 18, color: tokens.muted, textAlign: 'center' },
  card: { padding: 14, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 18, backgroundColor: tokens.surface, overflow: 'hidden' },
  cardHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  cardCopy: { minWidth: 0, overflowWrap: 'anywhere' },
  cardTitle: { margin: 0, fontSize: '.9375rem', fontWeight: 620, lineHeight: 1.4 },
  detail: { margin: '3px 0 0', color: tokens.muted, fontSize: '.75rem', lineHeight: 1.45, overflowWrap: 'anywhere' },
  badge: { flexShrink: 0, padding: '3px 8px', borderRadius: 999, backgroundColor: tokens.hover, color: tokens.primary, fontSize: '.6875rem', fontWeight: 600 },
  body: { margin: '10px 0 0', fontSize: '.8125rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  cardActions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  history: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: tokens.border },
  historyRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minWidth: 0, fontSize: '.75rem', overflowWrap: 'anywhere' },
  catalog: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 18 },
  catalogGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  catalogRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 38, padding: '4px 10px', borderRadius: 12, backgroundColor: tokens.surface, fontSize: '.8125rem' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 5, padding: '0 6px 6px' },
  chip: { maxWidth: '100%', padding: '4px 8px', borderRadius: 999, backgroundColor: tokens.hover, color: tokens.muted, fontSize: '.6875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  permissionRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0, minHeight: 58, padding: '8px 12px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 16, backgroundColor: tokens.surface },
  compactSelect: { flexShrink: 0, minHeight: 36, maxWidth: 112, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 11, padding: '4px 8px', backgroundColor: tokens.canvas, color: tokens.text, fontSize: '.75rem' },
  switchRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, minHeight: 48, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border },
  switchCopy: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 },
  switchInput: { width: 42, height: 24, flexShrink: 0, accentColor: tokens.primary },
  field: { display: 'flex', flexDirection: 'column', gap: 6, color: tokens.text, fontSize: '.8125rem', fontWeight: 550 },
  formCard: { display: 'flex', flexDirection: 'column', gap: 14, padding: 16, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 18, backgroundColor: tokens.surface },
  dialogFields: { display: 'flex', flexDirection: 'column', gap: 14 },
  textarea: { minHeight: 116, resize: 'vertical' },
  emptyState: { minHeight: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, textAlign: 'center', color: tokens.muted },
});
