import { ConfirmationModal } from '../../components/ui/ConfirmationModal';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import type {
  ProviderModelsInput,
  ProviderSettings,
  SavedProviderModel,
} from '../../../../shared/ai';
import {
  defaultCompatibleContext,
  defaultCompatibleOutput,
  findProviderPreset,
} from '../../../../shared/providerPresets';
import { ChatGPTModelSelect } from '../../components/ChatGPTModelSelect';
import { Sheet } from '../../components/ui/Sheet';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dropdown } from '../../components/ui/Dropdown';
import { errorText } from '../../utils/errors';
import { inputCapabilityLabel, modelInputCapabilities } from '../../../../shared/modelCapabilities';
import { ModelReasoningSettings } from './ModelReasoningSettings';
import { reasoningDefaultLabel } from '../../../../shared/reasoning';

export function ProviderModels({
  provider,
  onSave,
  disabled,
}: {
  provider: ProviderSettings;
  onSave: (value: ProviderModelsInput) => Promise<void>;
  disabled: boolean;
}) {
  const models = provider.models ?? [];
  const preset = findProviderPreset(provider);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<SavedProviderModel>(() => empty());
  const [error, setError] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  function empty(): SavedProviderModel {
    return {
      reasoningEffort: 'provider-default',
      id: '',
      name: '',
      contextWindowTokens: provider.kind === 'compatible' ? defaultCompatibleContext : null,
      maxOutputTokens: provider.kind === 'compatible' ? defaultCompatibleOutput : 8192,
      supportsImages: false,
    };
  }
  async function update(next: SavedProviderModel[], defaultModel = provider.defaultModel) {
    const selected = next.find((model) => model.id === defaultModel) ?? next[0];
    await onSave({ models: next, defaultModel: selected?.id ?? '' });
  }
  async function saveModel() {
    const id = draft.id.trim();
    if (
      !id ||
      !Number.isInteger(draft.contextWindowTokens) ||
      (draft.contextWindowTokens ?? 0) < 4096 ||
      (draft.contextWindowTokens ?? 0) > 10000000 ||
      !Number.isInteger(draft.maxOutputTokens) ||
      draft.maxOutputTokens < 256 ||
      draft.maxOutputTokens > 262144
    ) {
      setError(
        'Enter a model ID, a context window from 4,096 to 10,000,000 tokens, and an output limit from 256 to 262,144 tokens.',
      );
      return;
    }
    if (draft.maxOutputTokens >= draft.contextWindowTokens!) {
      setError(
        'The output limit must be smaller than the context window to leave room for your messages.',
      );
      return;
    }
    if (models.some((model) => model.id === id && model.id !== editing)) {
      setError('This model ID is already saved.');
      return;
    }
    const model = { ...draft, id, name: draft.name.trim() || id };
    setError('');
    try {
      await update(
        editing ? models.map((item) => (item.id === editing ? model : item)) : [...models, model],
        provider.defaultModel === editing ? id : provider.defaultModel,
      );
      setEditing(null);
    } catch (error) {
      setError(errorText(error));
    }
  }
  async function remove() {
    setError('');
    try {
      await update(models.filter((model) => model.id !== removeId));
      setRemoveId(null);
    } catch (error) {
      setError(errorText(error));
    }
  }
  function edit(model?: SavedProviderModel) {
    setEditing(model?.id ?? '');
    setDraft(model ? { ...model } : empty());
    setError('');
    setRemoveId(null);
  }
  return (
    <section className="provider-models" aria-label="Saved models" aria-busy={disabled}>
      <div className="provider-section-heading">
        <div>
          <h4>Models</h4>
          <p className="ai-caption">
            Choose the models available to your bots. Every change saves directly.
          </p>
        </div>
        <button
          type="button"
          className="button button--primary"
          disabled={disabled || models.length >= 200}
          onClick={() => edit()}
        >
          <Plus size={15} /> Add model
        </button>
      </div>
      {error && editing === null && (
        <div className="ai-alert" role="alert">
          {error}
        </div>
      )}
      {!!models.length && (
        <div className="provider-default-model ai-form">
          <label>
            Default model
            <Dropdown
              label="Default model"
              value={provider.defaultModel}
              disabled={disabled}
              options={models.map((model) => ({ value: model.id, label: model.name }))}
              onChange={(id) => {
                setError('');
                void update(models, id).catch((error) => setError(errorText(error)));
              }}
            />
            <small>Used when a bot follows this provider’s default.</small>
          </label>
        </div>
      )}
      <div className="provider-model-list">
        {models.map((model) => (
          <div className="provider-model-item" key={model.id}>
            <div className="provider-model-row">
              <div className="provider-model-info">
                <div className="provider-model-name">
                  <strong>{model.name}</strong>
                  {model.id === provider.defaultModel && (
                    <span className="provider-default">Default</span>
                  )}
                </div>
                <small className="provider-model-id">{model.id}</small>
                <span className="provider-model-limits">
                  {model.contextWindowTokens?.toLocaleString() ?? 'Unknown'} context ·{' '}
                  {model.maxOutputTokens.toLocaleString()} output ·{' '}
                  {reasoningDefaultLabel(provider, model.id)} reasoning ·{' '}
                  {inputCapabilityLabel(
                    modelInputCapabilities({ model: model.id, supportsImages: null }, provider),
                  )}
                </span>
              </div>
              <div className="ai-form-actions">
                <button
                  type="button"
                  className="button"
                  disabled={disabled}
                  onClick={() => edit(model)}
                  aria-label={`Edit ${model.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-button danger-text"
                  disabled={disabled}
                  onClick={() => {
                    setRemoveId(model.id);
                    setError('');
                  }}
                  aria-label={`Remove ${model.name}`}
                >
                  Remove
                </button>
              </div>
            </div>
            {removeId === model.id && (
              <ConfirmationModal
                title={`Remove ${model.name}?`}
                confirmLabel="Remove model"
                busy={disabled}
                error={error}
                onConfirm={() => void remove()}
                onClose={() => {
                  setRemoveId(null);
                  setError('');
                }}
              >
                <p>
                  Remove {model.name} from this provider’s model picker?
                  {model.id === provider.defaultModel &&
                    (models.length > 1
                      ? ' The next saved model becomes the default.'
                      : ' Add another model before using this provider again.')}{' '}
                  Bots assigned this model may need a new selection.
                </p>
              </ConfirmationModal>
            )}
          </div>
        ))}
        {!models.length && (
          <div className="provider-empty">
            <h4>No models yet</h4>
            <p>Add a model to make this connection available to your bots.</p>
          </div>
        )}
      </div>
      <p className="ai-caption">
        Context is the model’s total token capacity. Output is your per-response cap; shorter
        replies can use less. Set limits to match your model.
      </p>
      {editing !== null &&
        createPortal(
          <Sheet
            title={editing ? 'Edit model' : 'Add model'}
            className="provider-model-sheet"
            onClose={() => {
              if (!disabled) setEditing(null);
            }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveModel();
              }}
            >
              <div className="provider-model-editor ai-form bot-editor-body">
                {!!preset?.models.length && (
                  <label>
                    Suggested model
                    <Dropdown
                      label="Suggested model"
                      value={
                        preset.models.some((model) => model.id === draft.id) ? draft.id : 'custom'
                      }
                      disabled={disabled}
                      options={[
                        { value: 'custom', label: 'Custom model' },
                        ...preset.models.map((model) => ({
                          value: model.id,
                          label: model.name,
                          disabled: models.some(
                            (saved) => saved.id === model.id && saved.id !== editing,
                          ),
                        })),
                      ]}
                      onChange={(id) => {
                        setDraft(
                          id === 'custom'
                            ? empty()
                            : {
                                ...preset.models.find((model) => model.id === id)!,
                                reasoningEffort: 'provider-default',
                              },
                        );
                        setError('');
                      }}
                    />
                  </label>
                )}
                {provider.kind === 'chatgpt' ? (
                  <label>
                    Account model
                    <ChatGPTModelSelect
                      providerId={provider.id}
                      value={draft.id}
                      disabled={disabled}
                      onChange={(id, metadata) =>
                        setDraft({
                          ...draft,
                          id,
                          name: metadata?.name ?? id,
                          contextWindowTokens: metadata?.contextWindowTokens ?? null,
                          supportsImages: metadata?.supportsImages ?? false,
                          reasoningEffort: 'provider-default',
                          reasoningEfforts: metadata?.reasoningEfforts,
                        })
                      }
                    />
                  </label>
                ) : (
                  <label>
                    Model ID
                    <input
                      required
                      maxLength={150}
                      value={draft.id}
                      disabled={disabled}
                      placeholder="Exact model ID from your provider"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        const id = event.target.value;
                        const known = preset?.models.find((model) => model.id === id);
                        setDraft(
                          known
                            ? { ...known, reasoningEffort: 'provider-default' }
                            : {
                                ...draft,
                                id,
                                reasoningEffort: 'provider-default',
                                reasoningEfforts: undefined,
                                customReasoning: undefined,
                              },
                        );
                      }}
                    />
                  </label>
                )}
                <label>
                  Display name
                  <input
                    maxLength={150}
                    value={draft.name}
                    disabled={disabled}
                    placeholder={draft.id || 'Name shown in the picker'}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <div className="ai-form-grid">
                  <label>
                    Context window (tokens)
                    <input
                      required
                      type="number"
                      min={4096}
                      max={10000000}
                      step={1}
                      value={draft.contextWindowTokens ?? ''}
                      disabled={disabled}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          contextWindowTokens: event.target.value
                            ? Number(event.target.value)
                            : null,
                        })
                      }
                    />
                    <small>Use the documented capacity for this model.</small>
                  </label>
                  <label>
                    {provider.kind === 'chatgpt'
                      ? 'Output reserve (tokens)'
                      : 'Maximum output (tokens)'}
                    <input
                      required
                      type="number"
                      min={256}
                      max={262144}
                      step={1}
                      value={draft.maxOutputTokens}
                      disabled={disabled}
                      onChange={(event) =>
                        setDraft({ ...draft, maxOutputTokens: Number(event.target.value) })
                      }
                    />
                    <small>
                      {provider.kind === 'chatgpt'
                        ? 'Space reserved for the response.'
                        : 'Your per-response cap, within the model’s supported limit.'}
                    </small>
                  </label>
                </div>
                <ModelReasoningSettings
                  provider={provider}
                  draft={draft}
                  onChange={setDraft}
                  disabled={disabled}
                />
                <label className="ai-checkbox">
                  <Checkbox
                    checked={draft.supportsImages}
                    disabled={disabled}
                    onChange={(event) =>
                      setDraft({ ...draft, supportsImages: event.target.checked })
                    }
                  />
                  Supports images
                </label>
                <label className="ai-checkbox">
                  <Checkbox
                    checked={
                      draft.supportsAudio ??
                      modelInputCapabilities({ model: draft.id, supportsImages: null }, provider)
                        .supportsAudio
                    }
                    disabled={
                      disabled || !['google', 'openai', 'compatible'].includes(provider.kind)
                    }
                    onChange={(event) =>
                      setDraft({ ...draft, supportsAudio: event.target.checked })
                    }
                  />
                  Supports audio input (WAV, MP3)
                </label>
                <label className="ai-checkbox">
                  <Checkbox
                    checked={
                      draft.supportsVideo ??
                      modelInputCapabilities({ model: draft.id, supportsImages: null }, provider)
                        .supportsVideo
                    }
                    disabled={disabled || !['google', 'compatible'].includes(provider.kind)}
                    onChange={(event) =>
                      setDraft({ ...draft, supportsVideo: event.target.checked })
                    }
                  />
                  Supports video input (MP4, MOV)
                </label>
                <small>
                  Enable only inputs supported by the selected model and provider API. Existing
                  unsupported media stays in history as a text notice after switching models.
                </small>
                {error && (
                  <p className="ai-alert" role="alert">
                    {error}
                  </p>
                )}
              </div>
              <div className="modal-footer">
                <div className="ai-form-actions">
                  <button type="submit" className="button button--primary" disabled={disabled}>
                    {disabled ? 'Saving…' : 'Save model'}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={disabled}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          </Sheet>,
          document.body,
        )}
    </section>
  );
}
