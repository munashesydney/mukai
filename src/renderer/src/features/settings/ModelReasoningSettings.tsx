import type { ProviderSettings, SavedProviderModel } from '../../../../shared/ai';
import {
  reasoningChoiceLabel,
  reasoningDefaultLabel,
  reasoningLevels,
  reasoningLabels,
  reasoningProfile,
  type ReasoningEffort,
} from '../../../../shared/reasoning';
import { findProviderPreset } from '../../../../shared/providerPresets';
import { Dropdown } from '../../components/ui/Dropdown';
import { Checkbox } from '../../components/ui/Checkbox';

export function ModelReasoningSettings({
  provider,
  draft,
  onChange,
  disabled,
}: {
  provider: ProviderSettings;
  draft: SavedProviderModel;
  onChange: (value: SavedProviderModel) => void;
  disabled: boolean;
}) {
  const configured = { ...provider, models: [draft] };
  const profile = reasoningProfile(configured, draft.id);
  const custom = provider.kind === 'compatible' && !findProviderPreset(provider)?.models.length;
  return (
    <>
      <label>
        Default reasoning effort
        <Dropdown
          label="Default reasoning effort"
          disabled={disabled}
          value={draft.reasoningEffort ?? 'current'}
          options={[
            ...(draft.reasoningEffort === undefined
              ? [
                  {
                    value: 'current',
                    label: `Current: ${reasoningDefaultLabel(configured, draft.id)}`,
                  },
                ]
              : []),
            { value: 'provider-default', label: 'Provider default' },
            ...profile.levels.map((value) => ({
              value,
              label: reasoningChoiceLabel(configured, draft.id, value),
            })),
          ]}
          onChange={(value) =>
            onChange({
              ...draft,
              reasoningEffort: value === 'current' ? undefined : (value as ReasoningEffort),
            })
          }
        />
        <small>
          Used by bots that inherit this model’s effort. Higher effort can take longer and use more
          tokens.
        </small>
      </label>
      {custom && (
        <details>
          <summary>Custom reasoning support</summary>
          <p className="ai-caption">
            Declare only the effort values your endpoint accepts in its reasoning_effort field.
          </p>
          {reasoningLevels.map((level) => (
            <label className="ai-checkbox" key={level}>
              <Checkbox
                disabled={disabled}
                checked={draft.customReasoning?.supportedEfforts.includes(level) ?? false}
                onChange={(event) => {
                  const levels = draft.customReasoning?.supportedEfforts ?? [];
                  onChange({
                    ...draft,
                    customReasoning: {
                      supportedEfforts: event.target.checked
                        ? [...levels, level]
                        : levels.filter((value) => value !== level),
                    },
                    reasoningEffort:
                      draft.reasoningEffort === level && !event.target.checked
                        ? 'provider-default'
                        : draft.reasoningEffort,
                  });
                }}
              />
              {reasoningLabels[level]}
            </label>
          ))}
        </details>
      )}
    </>
  );
}
