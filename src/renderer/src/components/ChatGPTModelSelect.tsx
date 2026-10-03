import { useEffect, useState } from 'react';
import type { ProviderModel } from '../../../shared/ai';
import { providerService } from '../services/providerService';
import { errorText } from '../utils/errors';

const categories: ProviderModel['category'][] = ['GPT', 'Codex', 'Reasoning', 'Other'];
export function ChatGPTModelSelect({
  providerId,
  value,
  disabled,
  includeDefault = false,
  onChange,
}: {
  providerId: string;
  value: string;
  disabled?: boolean;
  includeDefault?: boolean;
  onChange: (id: string, model?: ProviderModel) => void;
}) {
  const [catalog, setCatalog] = useState<{ providerId: string; models: ProviderModel[] }>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    providerService
      .models(providerId)
      .then((models) => {
        if (alive) {
          setCatalog({ providerId, models });
          setError('');
        }
      })
      .catch((error) => {
        if (alive) setError(errorText(error));
      });
    return () => {
      alive = false;
    };
  }, [providerId, revision]);
  const models = catalog?.providerId === providerId ? catalog.models : [];
  const missing = Boolean(value && !models.some((model) => model.id === value));
  return (
    <>
      <select
        aria-label="ChatGPT model"
        value={value}
        disabled={disabled || !models.length}
        required={!includeDefault}
        onChange={(event) =>
          onChange(
            event.target.value,
            models.find((model) => model.id === event.target.value),
          )
        }
      >
        <option value="" disabled={!includeDefault}>
          {includeDefault ? 'Provider default' : 'Choose a model'}
        </option>
        {missing && (
          <option value={value} disabled>
            {value} (unavailable)
          </option>
        )}
        {categories.map((category) => {
          const group = models.filter((model) => model.category === category);
          return group.length ? (
            <optgroup key={category} label={category}>
              {group.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
      {error ? (
        <small role="alert">{error}</small>
      ) : catalog?.providerId !== providerId ? (
        <small>Loading account models…</small>
      ) : !models.length ? (
        <small>No selectable models are available for this account.</small>
      ) : missing ? (
        <small>This model is no longer available. Choose one from this account’s catalog.</small>
      ) : (
        <small>Models available to this ChatGPT account, grouped by family.</small>
      )}
      <button
        className="text-button"
        type="button"
        disabled={disabled}
        onClick={() => {
          setCatalog(undefined);
          setError('');
          setRevision(revision + 1);
        }}
      >
        Refresh models
      </button>
    </>
  );
}
