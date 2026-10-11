import { defaultBotInstructions } from '../../../../shared/botSystemPrompt';
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { mainBotRole, type Bot, type BotInput, type ProviderSettings } from '../../../../shared/ai';
import { Sheet } from '../../components/ui/Sheet';
import { Avatar } from '../../components/ui/Avatar';
import { botService } from '../../services/botService';
import { errorText } from '../../utils/errors';
import { botNameSuggestions } from '../../../../shared/toolAssignments';
import {
  botAvatarIds,
  botAvatarLabels,
  defaultBotAvatar,
  resolveBotAvatar,
} from '../../../../shared/mascots';

export function BotEditor({
  bot,
  providers,
  onClose,
  onSaved,
  onDeleted,
  workspaceId = 'default',
  isFirst = false,
}: {
  bot?: Bot;
  providers: ProviderSettings[];
  onClose: () => void;
  onSaved: (bot: Bot) => void;
  onDeleted: () => void;
  workspaceId?: string;
  isFirst?: boolean;
}) {
  const [value, setValue] = useState<BotInput>(
    bot
      ? { ...bot, avatar: resolveBotAvatar(bot.avatar) }
      : {
          name: isFirst ? 'Mukai' : '',
          role: isFirst ? mainBotRole : '',
          instructions: defaultBotInstructions,
          providerId: null,
          model: null,
          supportsImages: null,
          avatar: isFirst ? 'mukai-logo' : defaultBotAvatar,
        },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false);
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
      title={bot ? `Edit ${bot.name}` : isFirst ? 'Add your first bot' : 'Create a bot'}
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
              {isFirst && (
                <div className="first-bot-intro">
                  <strong>Your main bot</strong>
                  <p>
                    This bot leads your workspace. It can use all tools, manage pursuits, and create
                    other bots.
                  </p>
                </div>
              )}
              <div className="bot-avatar-options" role="group" aria-label="Bot identity">
                {botAvatarIds.map((avatar) => (
                  <button
                    type="button"
                    key={avatar}
                    aria-label={`Use ${botAvatarLabels[avatar]} mascot`}
                    title={botAvatarLabels[avatar]}
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
              {!bot && (
                <div className="bot-name-suggestions" role="group" aria-label="Suggested bot names">
                  <span>Try a name</span>
                  {botNameSuggestions.map((name) => (
                    <button
                      type="button"
                      key={name}
                      disabled={busy}
                      className={value.name === name ? 'is-selected' : ''}
                      onClick={() => setValue({ ...value, name })}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <label>
                Role
                <input
                  required
                  maxLength={120}
                  disabled={busy}
                  readOnly={isFirst || bot?.isMain}
                  value={value.role}
                  placeholder="e.g. Code architect"
                  onChange={(event) => setValue({ ...value, role: event.target.value })}
                />
                <small>
                  {isFirst || bot?.isMain
                    ? 'Your main bot coordinates the workspace.'
                    : 'Give the bot a name; put its job title here.'}
                </small>
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
              {!providers.length && (
                <p className="ai-caption">
                  You can create this bot now. Add a provider in Settings before chatting.
                </p>
              )}
              {!bot && !isFirst && (
                <p className="ai-caption">
                  Pursuits and bot management start unassigned. Change access in Tools → Workspace
                  tools.
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
                disabled={
                  busy || !value.name.trim() || !value.role.trim() || !value.instructions.trim()
                }
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
