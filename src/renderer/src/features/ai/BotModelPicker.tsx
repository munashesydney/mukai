import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Bot, BotModelInput, ProviderModel, ProviderSettings } from '../../../../shared/ai';
import { ChatGPTModelSelect } from '../../components/ChatGPTModelSelect';
import { Dropdown } from '../../components/ui/Dropdown';
import { Sheet } from '../../components/ui/Sheet';
import { botService } from '../../services/botService';
import { errorText } from '../../utils/errors';

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
  const [open, setOpen] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  const provider = providers.find((item) =>
    bot.providerId ? item.id === bot.providerId : item.isDefault,
  );
  async function change(value: BotModelInput, close = true) {
    if (pending.current || disabled) return;
    pending.current = true;
    setSaving(true);
    onSaving(true);
    setError('');
    try {
      onSelected(await botService.setModel(bot.id, value));
      if (close) setOpen(false);
    } catch (error) {
      setError(errorText(error));
    } finally {
      pending.current = false;
      setSaving(false);
      onSaving(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="ai-model-label ai-model-picker"
        aria-label={`Choose model for ${bot.name}`}
        aria-haspopup="dialog"
        disabled={disabled || saving}
        onClick={() => {
          if (!provider) {
            onProviders();
            return;
          }
          setError('');
          setOpen(true);
        }}
      >
        <span>
          {saving ? 'Saving model…' : bot.model || provider?.defaultModel || 'Choose a model'}
        </span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <Sheet
          title={`Model for ${bot.name}`}
          className="bot-model-sheet"
          onClose={() => {
            if (!saving) setOpen(false);
          }}
        >
          <div className="bot-editor-body ai-form">
            <p className="ai-caption">Changes save to this bot and apply to its next response.</p>
            {error && (
              <p className="ai-alert" role="alert">
                {error}
              </p>
            )}
            <label>
              Provider
              <Dropdown
                label="Model provider"
                value={bot.providerId || ''}
                disabled={disabled || saving}
                options={[
                  { value: '', label: 'Workspace default' },
                  ...providers.map((item) => ({ value: item.id, label: item.name })),
                ]}
                onChange={(id) =>
                  void change(
                    {
                      providerId: id || null,
                      model: null,
                      supportsImages: null,
                      contextWindowTokens: null,
                    },
                    false,
                  )
                }
              />
            </label>
            {provider && (
              <ModelChoices
                key={provider.id}
                bot={bot}
                provider={provider}
                disabled={disabled || saving}
                onChange={(model, metadata, contextWindowTokens) =>
                  void change({
                    providerId: bot.providerId,
                    model,
                    supportsImages:
                      metadata?.supportsImages ?? (model === bot.model ? bot.supportsImages : null),
                    contextWindowTokens:
                      contextWindowTokens ??
                      metadata?.contextWindowTokens ??
                      (model === bot.model ? bot.contextWindowTokens : null),
                  })
                }
              />
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}

function ModelChoices({
  bot,
  provider,
  disabled,
  onChange,
}: {
  bot: Bot;
  provider: ProviderSettings;
  disabled: boolean;
  onChange: (model: string | null, metadata?: ProviderModel, contextWindowTokens?: number) => void;
}) {
  const [custom, setCustom] = useState(false),
    [modelId, setModelId] = useState(bot.model || ''),
    [context, setContext] = useState(bot.contextWindowTokens?.toString() || '');
  if (provider.kind === 'chatgpt')
    return (
      <label>
        Model
        <ChatGPTModelSelect
          providerId={provider.id}
          value={bot.model || ''}
          includeDefault
          disabled={disabled}
          onChange={(id, model) => onChange(id || null, model)}
        />
      </label>
    );
  return (
    <>
      <label>
        Model
        <Dropdown
          label="Bot model"
          value={custom ? 'custom' : bot.model || ''}
          disabled={disabled}
          options={[
            { value: '', label: `Provider default · ${provider.defaultModel}` },
            ...(bot.model ? [{ value: bot.model, label: bot.model }] : []),
            { value: 'custom', label: 'Use another model…' },
          ]}
          onChange={(id) => {
            if (id === 'custom') setCustom(true);
            else onChange(id || null);
          }}
        />
      </label>
      {custom && (
        <form
          className="ai-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled) onChange(modelId.trim(), undefined, Number(context));
          }}
        >
          <label>
            Model ID
            <input
              required
              maxLength={150}
              disabled={disabled}
              value={modelId}
              placeholder="Exact model ID from your provider"
              onChange={(event) => setModelId(event.target.value)}
            />
          </label>
          <label>
            Context window (tokens)
            <input
              required
              type="number"
              min={4096}
              max={10000000}
              step={1}
              disabled={disabled}
              value={context}
              onChange={(event) => setContext(event.target.value)}
            />
            <small>Enter this model’s documented capacity.</small>
          </label>
          <button
            className="button button--primary"
            type="submit"
            disabled={disabled || !modelId.trim() || !context}
          >
            Use model
          </button>
        </form>
      )}
    </>
  );
}
