import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProviderInput, ProviderSettings, SavedProviderModel } from '../../../../shared/ai';
import { ChatGPTModelSelect } from '../../components/ChatGPTModelSelect';
import { Sheet } from '../../components/ui/Sheet';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dropdown } from '../../components/ui/Dropdown';

const empty = (): SavedProviderModel => ({
  id: '',
  name: '',
  contextWindowTokens: null,
  maxOutputTokens: 8192,
  supportsImages: false,
});
export function ProviderModels({
  value,
  onChange,
  disabled,
  provider,
}: {
  value: ProviderInput;
  onChange: (value: ProviderInput) => void;
  disabled: boolean;
  provider: ProviderSettings;
}) {
  const models = value.models ?? [];
  const [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState(empty),
    [error, setError] = useState('');
  function update(next: SavedProviderModel[], defaultModel = value.defaultModel) {
    const selected = next.find((model) => model.id === defaultModel) ?? next[0];
    onChange({
      ...value,
      models: next,
      defaultModel: selected?.id ?? '',
      contextWindowTokens: selected?.contextWindowTokens ?? null,
      maxOutputTokens: selected?.maxOutputTokens ?? 8192,
      supportsImages: selected?.supportsImages ?? false,
    });
  }
  function keep() {
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
      setError('Enter a model ID and valid context and output limits.');
      return;
    }
    if (models.some((model) => model.id === id && model.id !== editing)) {
      setError('This model ID is already saved.');
      return;
    }
    const model = { ...draft, id, name: draft.name.trim() || id };
    update(
      editing ? models.map((item) => (item.id === editing ? model : item)) : [...models, model],
      value.defaultModel === editing ? id : value.defaultModel,
    );
    setEditing(null);
  }
  return (
    <section className="provider-models ai-form" aria-label="Saved models">
      <div>
        <h4>Models</h4>
        <p className="ai-caption">
          Add the models you want in the picker. Each model has its own limits and capabilities.
        </p>
      </div>
      {models.map((model) => (
        <div className="provider-model-row" key={model.id}>
          <span>
            <strong>{model.name}</strong>
            <small>
              {model.id} · {model.contextWindowTokens?.toLocaleString() ?? 'Unknown'} context ·{' '}
              {model.maxOutputTokens.toLocaleString()} output
            </small>
          </span>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => {
              setEditing(model.id);
              setDraft({ ...model });
              setError('');
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="text-button danger-text"
            disabled={disabled}
            onClick={() => update(models.filter((item) => item.id !== model.id))}
          >
            Remove
          </button>
        </div>
      ))}
      {!!models.length && (
        <label>
          Default model
          <Dropdown
            label="Default model"
            value={value.defaultModel}
            disabled={disabled}
            options={models.map((model) => ({ value: model.id, label: model.name }))}
            onChange={(id) => update(models, id)}
          />
        </label>
      )}
      {editing === null ? (
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => {
            setEditing('');
            setDraft(empty());
            setError('');
          }}
        >
          Add model
        </button>
      ) : (
        createPortal(
          <Sheet
            title={editing ? 'Edit model' : 'Add model'}
            className="provider-model-sheet"
            onClose={() => setEditing(null)}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                keep();
              }}
            >
              <div className="provider-model-editor ai-form bot-editor-body">
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
                        })
                      }
                    />
                  </label>
                ) : (
                  <label>
                    Model ID
                    <input
                      maxLength={150}
                      value={draft.id}
                      disabled={disabled}
                      placeholder="Exact model ID from your provider"
                      onChange={(event) => setDraft({ ...draft, id: event.target.value })}
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
                  </label>
                </div>
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
                {error && (
                  <p className="ai-alert" role="alert">
                    {error}
                  </p>
                )}
              </div>
              <div className="modal-footer">
                <div className="ai-form-actions">
                  <button type="submit" className="button button--primary" disabled={disabled}>
                    Keep model
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
        )
      )}
      <small>Save the connection to apply model changes.</small>
    </section>
  );
}
