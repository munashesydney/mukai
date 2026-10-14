import { Bot, Layers3 } from 'lucide-react';
import type { TelegramAccessInput, TelegramWorkspaceAccess } from '../../../../shared/telegram';

export function TelegramWorkspaceAccess({
  workspaces,
  selection,
  onChange,
  disabled,
}: {
  workspaces: TelegramWorkspaceAccess[];
  selection: TelegramAccessInput['workspaces'];
  onChange: (selection: TelegramAccessInput['workspaces']) => void;
  disabled: boolean;
}) {
  return (
    <div className="telegram-workspaces">
      {!workspaces.length && <p>Create a workspace in Mukai, then return here to enable access.</p>}
      {workspaces.map((workspace) => {
        const selected = selection.find((item) => item.workspaceId === workspace.id);
        const inputId = `telegram-workspace-${workspace.id}`;
        return (
          <div className={`telegram-workspace ${selected ? 'is-selected' : ''}`} key={workspace.id}>
            <label className="telegram-workspace-label" htmlFor={inputId}>
              <input
                id={inputId}
                type="checkbox"
                aria-label={workspace.name}
                checked={Boolean(selected)}
                disabled={disabled || !workspace.bots.length}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selection, { workspaceId: workspace.id, botId: null }]
                      : selection.filter((item) => item.workspaceId !== workspace.id),
                  )
                }
              />
              <span className="telegram-workspace-icon">
                <Layers3 size={17} />
              </span>
              <span>
                <strong>{workspace.name}</strong>
                <small>
                  {workspace.bots.length
                    ? `${workspace.bots.length} bot${workspace.bots.length === 1 ? '' : 's'}`
                    : 'Add a bot in this workspace first'}
                </small>
              </span>
            </label>
            {selected && (
              <label className="telegram-bot-select">
                <Bot size={15} />
                <select
                  aria-label={`Responding bot for ${workspace.name}`}
                  value={selected.botId || ''}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      selection.map((item) =>
                        item.workspaceId === workspace.id
                          ? { ...item, botId: event.target.value || null }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="">Main bot (automatic)</option>
                  {workspace.bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                      {bot.isMain ? ' · main' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
