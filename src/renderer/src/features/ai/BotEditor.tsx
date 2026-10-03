import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Bot, BotInput, ProviderSettings } from '../../../../shared/ai';
import { Sheet } from '../../components/ui/Sheet';
import { Avatar } from '../../components/ui/Avatar';
import { Dropdown } from '../../components/ui/Dropdown';
import { botService } from '../../services/botService';
import { errorText } from '../../utils/errors';

export function BotEditor({
  bot,
  providers,
  onClose,
  onSaved,
  onDeleted,
  workspaceId = 'default',
}: {
  bot?: Bot;
  providers: ProviderSettings[];
  onClose: () => void;
  onSaved: (bot: Bot) => void;
  onDeleted: () => void;
  workspaceId?: string;
}) {
  const [value, setValue] = useState<BotInput>(
    bot || {
      name: '',
      description: '',
      instructions: 'You are a helpful, thoughtful assistant. Be clear, practical, and honest.',
      providerId: null,
      model: null,
      supportsImages: null,
      avatar: 'nova',
    },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false);
  const provider = providers.find((provider) =>
    value.providerId ? provider.id === value.providerId : provider.isDefault,
  );
  async function save() {
    setBusy(true);
    setError('');
    try {
      onSaved(
        await (bot ? botService.update(bot.id, value) : botService.create(value, workspaceId)),
      );
    } catch (error) {
      setError(errorText(error));
      setBusy(false);
    }
  }
  async function remove() {
    if (!bot) return;
    setBusy(true);
    setError('');
    try {
      await botService.remove(bot.id);
      onDeleted();
    } catch (error) {
      setError(errorText(error));
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={bot ? `Edit ${bot.name}` : 'Create a bot'}
      className="bot-editor"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="ai-form bot-editor-body">
          {error && (
            <div className="ai-alert" role="alert">
              {error}
            </div>
          )}
          {deleting ? (
            <div className="delete-confirm">
              <h3>Delete {bot?.name}?</h3>
              <p>This permanently deletes this bot, its entire chat, and its attachments.</p>
              <button
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                Delete bot and chat
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setDeleting(false)}
              >
                Keep bot
              </button>
            </div>
          ) : (
            <>
              <div className="bot-avatar-options" role="group" aria-label="Bot identity">
                {(['scout', 'nova', 'atlas'] as const).map((avatar) => (
                  <button
                    type="button"
                    key={avatar}
                    aria-label={`Use ${avatar} icon`}
                    aria-pressed={value.avatar === avatar}
                    className={value.avatar === avatar ? 'is-selected' : ''}
                    disabled={busy}
                    onClick={() => setValue({ ...value, avatar })}
                  >
                    <Avatar person={avatar} />
                  </button>
                ))}
              </div>
              <label>
                Name
                <input
                  required
                  maxLength={60}
                  disabled={busy}
                  value={value.name}
                  placeholder="What shall we call them?"
                  onChange={(event) => setValue({ ...value, name: event.target.value })}
                />
              </label>
              <label>
                Description <span>(optional)</span>
                <input
                  maxLength={400}
                  disabled={busy}
                  value={value.description}
                  placeholder="A little about this bot"
                  onChange={(event) => setValue({ ...value, description: event.target.value })}
                />
              </label>
              <label>
                Instructions
                <textarea
                  required
                  rows={5}
                  maxLength={12000}
                  disabled={busy}
                  value={value.instructions}
                  onChange={(event) => setValue({ ...value, instructions: event.target.value })}
                />
                <small>Tell your bot how to help, what to focus on, and how to respond.</small>
              </label>
              <div className="ai-form-grid">
                <label>
                  Provider
                  <Dropdown
                    label="Provider"
                    disabled={busy}
                    value={value.providerId || ''}
                    onChange={(providerId) =>
                      setValue({
                        ...value,
                        providerId: providerId || null,
                        model: null,
                        supportsImages: null,
                        contextWindowTokens: null,
                        maxOutputTokens: null,
                      })
                    }
                    options={[
                      { value: '', label: 'Workspace default' },
                      ...providers.map((provider) => ({
                        value: provider.id,
                        label: provider.name,
                      })),
                    ]}
                  />
                </label>
                <label>
                  Model
                  <input
                    maxLength={150}
                    disabled={busy}
                    placeholder={provider?.defaultModel || 'Provider default'}
                    value={value.model || ''}
                    onChange={(event) =>
                      setValue({
                        ...value,
                        model: event.target.value.trim() || null,
                        contextWindowTokens: null,
                      })
                    }
                  />
                </label>
              </div>
              <div className="ai-form-grid">
                <label>
                  Context window (tokens)
                  <input
                    type="number"
                    min={4096}
                    max={10000000}
                    step={1}
                    disabled={busy}
                    required={Boolean(value.model && value.model !== provider?.defaultModel)}
                    value={value.contextWindowTokens ?? ''}
                    placeholder={
                      !value.model || value.model === provider?.defaultModel
                        ? String(provider?.contextWindowTokens ?? 'Provider setting')
                        : 'Enter this model’s capacity'
                    }
                    onChange={(event) =>
                      setValue({
                        ...value,
                        contextWindowTokens: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                  />
                  <small>A different model needs its own context-window size.</small>
                </label>
                <label>
                  Maximum output (tokens)
                  <input
                    type="number"
                    min={256}
                    max={262144}
                    step={1}
                    disabled={busy}
                    value={value.maxOutputTokens ?? ''}
                    placeholder={String(provider?.maxOutputTokens ?? 8192)}
                    onChange={(event) =>
                      setValue({
                        ...value,
                        maxOutputTokens: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                  />
                </label>
              </div>
              <label>
                Image capability
                <Dropdown
                  label="Image capability"
                  disabled={busy}
                  value={value.supportsImages === null ? 'inherit' : String(value.supportsImages)}
                  onChange={(capability) =>
                    setValue({
                      ...value,
                      supportsImages: capability === 'inherit' ? null : capability === 'true',
                    })
                  }
                  options={[
                    {
                      value: 'inherit',
                      label: `Use provider setting (${provider?.supportsImages ? 'images enabled' : 'text only'})`,
                    },
                    { value: 'true', label: 'This model supports images' },
                    { value: 'false', label: 'Text only' },
                  ]}
                />
                <small>Confirm your chosen model supports vision before enabling images.</small>
              </label>
              {!providers.length && (
                <p className="ai-caption">
                  You can create this bot now. Add a provider in Settings before chatting.
                </p>
              )}
            </>
          )}
        </div>
        {!deleting && (
          <div className="modal-footer">
            <div>
              {bot && (
                <button
                  type="button"
                  className="text-button danger-text"
                  disabled={busy}
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 size={15} />
                  Delete bot
                </button>
              )}
            </div>
            <div className="ai-form-actions">
              <button type="button" className="button" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="button button--primary"
                disabled={busy || !value.name.trim() || !value.instructions.trim()}
              >
                {busy ? 'Saving…' : bot ? 'Save changes' : 'Create bot'}
              </button>
            </div>
          </div>
        )}
      </form>
    </Sheet>
  );
}
