import { useEffect, useRef, useState } from 'react';
import { Check, ChevronUp } from 'lucide-react';
import type { Bot, BotModelInput, ProviderModel, ProviderSettings } from '../../../../shared/ai';
import { PopupMenu } from '../../components/ui/PopupMenu';
import { botService } from '../../services/botService';
import { providerService } from '../../services/providerService';
import { errorText } from '../../utils/errors';
import { inputCapabilityLabel, modelInputCapabilities } from '../../../../shared/modelCapabilities';
import {
  reasoningChoiceLabel,
  reasoningDefaultLabel,
  reasoningProfile,
  type ReasoningEffort,
} from '../../../../shared/reasoning';

export function BotModelPicker({
  bot,
  providers,
  disabled,
  onSelected,
  onSaving,
  onProviders,
}: {
  bot: Bot;
  providers: ProviderSettings[];
  disabled: boolean;
  onSelected: (bot: Bot) => void;
  onSaving: (saving: boolean) => void;
  onProviders: () => void;
}) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [catalog, setCatalog] = useState<Record<string, ProviderModel[]>>({});
  const pending = useRef(false);
  const selectedProvider = providers.find((item) =>
    bot.providerId ? item.id === bot.providerId : item.isDefault,
  );
  const provider = selectedProvider && {
    ...selectedProvider,
    models: [
      ...(selectedProvider.models ?? []).map((saved) => {
        const advertised = catalog[selectedProvider.id]?.find(
          (model) => model.id === saved.id,
        )?.reasoningEfforts;
        return advertised ? { ...saved, reasoningEfforts: advertised } : saved;
      }),
      ...(catalog[selectedProvider.id] ?? [])
        .filter((model) => !selectedProvider.models?.some((saved) => saved.id === model.id))
        .map((model) => ({
          id: model.id,
          name: model.name,
          supportsImages: model.supportsImages ?? false,
          contextWindowTokens: model.contextWindowTokens,
          maxOutputTokens: selectedProvider.maxOutputTokens ?? 8192,
          reasoningEffort: 'provider-default' as const,
          reasoningEfforts: model.reasoningEfforts,
        })),
    ],
  };
  useEffect(() => {
    let alive = true;
    void Promise.all(
      providers
        .filter(
          (item) => item.kind === 'chatgpt' && item.account?.connected && item.account.planEnabled,
        )
        .map(async (item) => {
          try {
            const models = await providerService.models(item.id);
            if (alive) setCatalog((current) => ({ ...current, [item.id]: models }));
          } catch {
            /* Saved models remain visible if discovery is unavailable. */
          }
        }),
    );
    return () => {
      alive = false;
    };
  }, [providers]);
  async function change(value: BotModelInput, close: () => void) {
    if (pending.current || disabled) return;
    pending.current = true;
    setSaving(true);
    onSaving(true);
    setError('');
    try {
      onSelected(await botService.setModel(bot.id, value));
      close();
    } catch (error) {
      setError(errorText(error));
    } finally {
      pending.current = false;
      setSaving(false);
      onSaving(false);
    }
  }
  const active = bot.model || provider?.defaultModel;
  const name =
    provider?.models?.find((model) => model.id === active)?.name ||
    catalog[provider?.id ?? '']?.find((model) => model.id === active)?.name ||
    active;
  const effortLabel =
    bot.reasoningEffort && provider
      ? reasoningChoiceLabel(provider, active || '', bot.reasoningEffort)
      : provider
        ? `Inherit · ${reasoningDefaultLabel(provider, active || '')}`
        : 'Reasoning';
  return (
    <span className="ai-model-controls">
      <PopupMenu
        label={`Choose model for ${bot.name}`}
        title="Choose a model"
        placement="top"
        menuClassName="bot-model-menu"
        buttonClassName="ai-model-label ai-model-picker"
        disabled={disabled}
        trigger={
          <>
            <span>{saving ? 'Saving model...' : name || 'Workspace default'}</span>
            <ChevronUp size={13} />
          </>
        }
        footer={
          <button type="button" role="menuitem" className="text-button" onClick={onProviders}>
            Configure models
          </button>
        }
      >
        {(close) => (
          <>
            {error && (
              <div className="ai-alert" role="alert">
                {error}
              </div>
            )}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!bot.providerId && !bot.model}
              disabled={saving}
              onClick={() =>
                void change(
                  {
                    providerId: null,
                    model: null,
                    supportsImages: null,
                    contextWindowTokens: null,
                  },
                  close,
                )
              }
            >
              <span>
                <strong>Workspace default</strong>
                <small>
                  {providers.find((item) => item.isDefault)?.name ||
                    'Configure a provider in Settings'}
                </small>
              </span>
              {!bot.providerId && !bot.model && <Check size={16} />}
            </button>
            {providers.map((item) => {
              const choices = new Map(
                (item.models ?? []).map((model) => [model.id, { id: model.id, name: model.name }]),
              );
              for (const model of catalog[item.id] ?? [])
                if (!choices.has(model.id)) choices.set(model.id, model);
              if (item.defaultModel && !choices.has(item.defaultModel))
                choices.set(item.defaultModel, { id: item.defaultModel, name: item.defaultModel });
              return (
                <section
                  key={item.id}
                  role="group"
                  aria-label={item.name}
                  className="bot-model-group"
                >
                  <h4>{item.name}</h4>
                  {[...choices.values()].map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      role="menuitemradio"
                      title={inputCapabilityLabel(
                        modelInputCapabilities({ model: model.id, supportsImages: null }, item),
                      )}
                      aria-checked={bot.providerId === item.id && active === model.id}
                      disabled={
                        saving ||
                        (item.kind === 'chatgpt' &&
                          (!item.account?.connected || !item.account.planEnabled))
                      }
                      onClick={() =>
                        void change(
                          {
                            providerId: item.id,
                            model: model.id,
                            supportsImages: null,
                            contextWindowTokens: null,
                          },
                          close,
                        )
                      }
                    >
                      <span>{model.name}</span>
                      {bot.providerId === item.id && active === model.id && <Check size={16} />}
                    </button>
                  ))}
                  {!choices.size && <small>Add models in Settings.</small>}
                </section>
              );
            })}
          </>
        )}
      </PopupMenu>
      {provider && (
        <PopupMenu
          label={`Reasoning effort for ${bot.name}`}
          title="Reasoning effort"
          placement="top"
          menuClassName="bot-model-menu"
          buttonClassName="ai-model-label ai-model-picker"
          disabled={disabled || saving}
          trigger={
            <>
              <span>{effortLabel}</span>
              <ChevronUp size={13} />
            </>
          }
        >
          {(close) => (
            <>
              {error && (
                <div className="ai-alert" role="alert">
                  {error}
                </div>
              )}
              {(
                [
                  {
                    value: null,
                    label: `Inherit · ${reasoningDefaultLabel(provider, active || '')}`,
                  },
                  { value: 'provider-default' as const, label: 'Provider default' },
                  ...reasoningProfile(provider, active || '').levels.map((value) => ({
                    value,
                    label: reasoningChoiceLabel(provider, active || '', value),
                  })),
                ] as { value: ReasoningEffort | null; label: string }[]
              ).map((option) => (
                <button
                  key={option.value ?? 'inherit'}
                  type="button"
                  role="menuitemradio"
                  aria-checked={(bot.reasoningEffort ?? null) === option.value}
                  onClick={() =>
                    void change(
                      {
                        providerId: bot.providerId,
                        model: bot.model,
                        supportsImages: null,
                        contextWindowTokens: null,
                        reasoningEffort: option.value,
                      },
                      close,
                    )
                  }
                >
                  <span>{option.label}</span>
                  {(bot.reasoningEffort ?? null) === option.value && <Check size={16} />}
                </button>
              ))}
            </>
          )}
        </PopupMenu>
      )}
    </span>
  );
}
