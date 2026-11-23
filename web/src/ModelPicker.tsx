import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Check } from 'lucide-react';
import { parseModelConfig, parseModels } from './responses';
import { tokens } from './tokens.stylex';
import { ICON_STROKE } from './ui';
import { Dialog } from './Dialog';
import { Button } from './Button';
import type { Starter } from './Composer';
import type { AvailableModel, ModelConfig, UseChat } from './types';

const MODEL_STORAGE_KEY = 'asideModel';
const THINKING_STORAGE_KEY = 'asideThinkingLevel';
const THINKING_LABELS: Record<string, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

export function useModelSelection(chat: UseChat, notify: (text: string, kind?: 'error' | 'success') => void, starter?: Starter) {
  const [catalog, setCatalog] = useState<{ sessionId?: string; items: AvailableModel[]; current: ModelConfig }>();
  const [error, setError] = useState<string>();
  const [isUpdating, setUpdating] = useState(false);
  const generation = useRef(0);
  const mutation = useRef<{ controller: AbortController; version: number } | undefined>(undefined);
  const { sessionId, isReady, authError, request } = chat;
  const [revision, setRevision] = useState(0);
  const loaded = catalog?.sessionId === sessionId ? catalog : undefined;

  const [manuallyChanged, setManuallyChanged] = useState<Starter>();
  const preset = !sessionId && starter && starter !== manuallyChanged
    ? loaded?.items.find(model => model.provider === 'claude-code' && model.id === 'claude-opus-5-5') : undefined;
  const current = preset && loaded ? configureModel(preset, { ...loaded.current, thinkingLevel: 'high' }) : loaded?.current;

  useEffect(() => {
    const version = ++generation.current;
    const controller = new AbortController();
    setError(undefined);
    if (isReady && !authError) void load();
    return () => {
      generation.current += 1;
      controller.abort();
      const pending = mutation.current;
      if (pending) {
        pending.controller.abort();
        mutation.current = undefined;
        setUpdating(false);
      }
    };

    async function load() {
      try {
        const response = await request('/api/models' + (sessionId ? '?session_id=' + encodeURIComponent(sessionId) : ''), { signal: controller.signal });
        const result = parseModels(await response.json());
        if (controller.signal.aborted || version !== generation.current) return;
        const savedModel = !sessionId && readPreference(MODEL_STORAGE_KEY);
        const saved = !sessionId && result.items.find(model => savedModel ? `${model.provider}/${model.id}` === savedModel : model.id === result.current.modelId && model.provider === result.current.provider);
        setCatalog({ sessionId, ...result, current: saved ? configureModel(saved, { ...result.current, thinkingLevel: readPreference(THINKING_STORAGE_KEY) ?? result.current.thinkingLevel }) : result.current });
      } catch {
        if (!controller.signal.aborted && version === generation.current) setError('Could not load models.');
      }
    }
  }, [sessionId, isReady, authError, request, revision]);

  async function select(model: AvailableModel, thinkingLevel?: string) {
    if (!loaded || mutation.current) return false;
    const owner = { controller: new AbortController(), version: ++generation.current };
    mutation.current = owner;
    setUpdating(true);
    const config = configureModel(model, thinkingLevel ? { ...loaded.current, thinkingLevel } : loaded.current);
    setCatalog({ ...loaded, current: config });
    try {
      const current = sessionId
        ? parseModelConfig(await (await request('/api/sessions/' + encodeURIComponent(sessionId) + '/model', {
          method: 'PUT', body: JSON.stringify(config),
          signal: AbortSignal.any([owner.controller.signal, AbortSignal.timeout(60_000)]),
        })).json())
        : config;
      if (owner.version !== generation.current || mutation.current !== owner) return false;
      setCatalog({ ...loaded, current });
      setManuallyChanged(starter);
      if (!savePreference(current)) notify('Model selected, but this choice could not be saved.', 'error');
      return true;
    } catch {
      if (owner.version === generation.current && mutation.current === owner) { setCatalog(loaded); notify('Could not update model settings. Try again.', 'error'); }
      return false;
    } finally {
      if (mutation.current === owner) { mutation.current = undefined; setUpdating(false); }
    }
  }

  return { items: loaded?.items ?? [], current, error, isUpdating, select, reload: () => setRevision(value => value + 1) };
}

function readPreference(key: string) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function savePreference(current: ModelConfig) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, `${current.provider}/${current.modelId}`);
    localStorage.setItem(THINKING_STORAGE_KEY, current.thinkingLevel);
    return true;
  } catch { return false; }
}

function configureModel(model: AvailableModel, current: ModelConfig): ModelConfig {
  return { provider: model.provider, modelId: model.id,
    thinkingLevel: model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels.includes('high') ? 'high' : model.thinkingLevels[0],
    fastMode: model.supportsFastMode && current.fastMode };
}

/** Short label for the current model and reasoning effort, such as "Claude Opus 5.5 · High". */
/** The display name of the selected model, or undefined while the catalog loads. */
export function modelName(selection: ReturnType<typeof useModelSelection>) {
  const current = selection.items.find(model => model.id === selection.current?.modelId && model.provider === selection.current.provider);
  return current?.name ?? selection.current?.modelId;
}

export function modelLabel(selection: ReturnType<typeof useModelSelection>) {
  const name = modelName(selection);
  const thinking = selection.current && (THINKING_LABELS[selection.current.thinkingLevel] ?? selection.current.thinkingLevel);
  return name ? (thinking ? `${name} · ${thinking}` : name) : 'Loading…';
}

/** The Models sheet. The choice is saved on the device and used for every new chat until it is changed here. */
export function ModelSheet({ selection, disabled, isRunning, onClose }: {
  selection: ReturnType<typeof useModelSelection>; disabled: boolean; isRunning: boolean; onClose: () => void;
}) {
  const current = selection.items.find(model => model.id === selection.current?.modelId && model.provider === selection.current.provider);
  const providers = [...new Set(selection.items.map(model => model.provider))];

  return <Dialog key="models" title="Models" onClose={onClose}>
    {isRunning && <p {...stylex.props(styles.note)}>Applies to your next response.</p>}
    {selection.error ? <p role="alert" {...stylex.props(styles.note)}>{selection.error} <Button size="compact" onClick={selection.reload}>Try again</Button></p> : !selection.current && <p role="status" {...stylex.props(styles.note)}>Loading models…</p>}
    {current && selection.current && <label {...stylex.props(styles.reasoning)}><span>Reasoning effort</span>
      <select aria-label="Reasoning effort" value={selection.current.thinkingLevel} disabled={disabled || selection.isUpdating} {...stylex.props(styles.effortSelect)} onChange={event => { void selection.select(current, event.target.value); }}>
        {current.thinkingLevels.map(level => <option key={level} value={level}>{THINKING_LABELS[level] ?? level}</option>)}
      </select>
    </label>}
    {providers.map(provider => <section key={provider} aria-label={provider} {...stylex.props(styles.group)}>
      <h3 {...stylex.props(styles.provider)}>{provider === 'openai-codex' ? 'OpenAI Codex' : provider === 'aside' ? 'Aside' : provider}</h3>
      {sortModels(selection.items.filter(model => model.provider === provider)).map(model => {
        const isSelected = model.id === selection.current?.modelId && model.provider === selection.current.provider;
        return <button key={model.id} type="button" aria-label={model.name + ', ' + provider} aria-pressed={isSelected} disabled={selection.isUpdating || disabled} {...stylex.props(styles.option, isSelected && styles.selected)} onClick={() => { onClose(); void selection.select(model); }}>
          <span {...stylex.props(styles.name)}>{model.name}</span>{isSelected && <Check {...stylex.props(styles.check)} size={19} strokeWidth={ICON_STROKE} aria-hidden="true" />}
        </button>;
      })}
    </section>)}
    {selection.isUpdating && <p role="status" {...stylex.props(styles.note)}>Updating model settings…</p>}
  </Dialog>;
}

function sortModels(models: AvailableModel[]) {
  const family = (model: AvailableModel) => model.name.match(/^[a-z]+/i)?.[0] ?? model.name;
  const families = [...new Set(models.map(family))];
  return [...models].sort((first, second) => families.indexOf(family(first)) - families.indexOf(family(second))
    || (second.name.match(/\d+(?:\.\d+)*/)?.[0] ?? '').localeCompare(first.name.match(/\d+(?:\.\d+)*/)?.[0] ?? '', 'en', { numeric: true }));
}

const styles = stylex.create({
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  note: { color: tokens.muted, fontSize: '0.8125rem', lineHeight: 1.5, margin: '0 0 14px' },
  group: { marginBottom: 16 },
  reasoning: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 12px', marginBottom: 20, color: tokens.muted, fontSize: '0.8125rem' },
  effortSelect: { minHeight: 44, maxWidth: '55%', borderWidth: 0, borderRadius: 12, padding: '0 12px', backgroundColor: tokens.surface, color: tokens.text, fontFamily: 'inherit', fontSize: '0.875rem' },
  provider: { color: tokens.muted, fontSize: '0.75rem', fontWeight: 500, margin: '0 12px 6px' },
  option: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, padding: '10px 12px', borderWidth: 0, borderRadius: 12, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text, textAlign: 'left', fontSize: '0.9375rem' },
  selected: { backgroundColor: tokens.surface },
  check: { color: tokens.primary, flexShrink: 0 },
});
