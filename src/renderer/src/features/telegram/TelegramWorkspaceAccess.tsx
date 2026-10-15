import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Plus } from 'lucide-react';
import type { TelegramAccessInput, TelegramWorkspaceAccess } from '../../../../shared/telegram';
import { Checkbox } from '../../components/ui/Checkbox';
import { IconButton } from '../../components/ui/IconButton';

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
  const [view, setView] = useState<'list' | 'add' | 'bot'>('list');
  const [workspaceId, setWorkspaceId] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current !== view) heading.current?.focus();
    previousView.current = view;
  }, [view]);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const selected = selection.find((item) => item.workspaceId === workspaceId);
  const editingBot = view === 'bot' && workspace && selected;
  const added = workspaces.filter((item) =>
    selection.some((entry) => entry.workspaceId === item.id),
  );
  const available = workspaces.filter((item) => item.bots.length);
  const canAdd = available.some(
    (item) => !selection.some((entry) => entry.workspaceId === item.id),
  );

  function addAll() {
    onChange(
      available.map(
        (item) =>
          selection.find((entry) => entry.workspaceId === item.id) ?? {
            workspaceId: item.id,
            botId: null,
          },
      ),
    );
  }

  return (
    <section
      className="telegram-workspace-card"
      aria-label="Telegram workspaces"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && view !== 'list' && !disabled) {
          event.stopPropagation();
          setView('list');
        }
      }}
    >
      <div className="telegram-card-heading">
        {view !== 'list' && (
          <IconButton
            label="Back to workspaces"
            disabled={disabled}
            onClick={() => setView('list')}
          >
            <ArrowLeft size={19} />
          </IconButton>
        )}
        <h2 ref={heading} tabIndex={-1}>
          {view === 'add' ? 'Add workspaces' : editingBot ? workspace.name : 'Workspaces'}
        </h2>
        {view === 'list' && (
          <span
            className="telegram-workspace-count"
            aria-label={`${added.length} workspaces added`}
          >
            {added.length}
          </span>
        )}
        <div className="telegram-card-actions">
          {!editingBot && canAdd && (
            <button className="text-button" disabled={disabled} onClick={addAll}>
              Add all
            </button>
          )}
          {view === 'list' && (
            <IconButton
              className="telegram-add-workspace"
              label="Add workspaces"
              disabled={disabled || !workspaces.length}
              onClick={() => setView('add')}
            >
              <Plus size={21} />
            </IconButton>
          )}
        </div>
      </div>
      {view === 'add' ? (
        <div className="telegram-workspace-choices">
          <p className="telegram-card-hint">Choose the workspaces you’d like to use in Telegram.</p>
          {workspaces.map((item) => (
            <label className="telegram-workspace-choice" key={item.id}>
              <Checkbox
                aria-label={item.name}
                checked={selection.some((entry) => entry.workspaceId === item.id)}
                disabled={disabled || !item.bots.length}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selection, { workspaceId: item.id, botId: null }]
                      : selection.filter((entry) => entry.workspaceId !== item.id),
                  )
                }
              />
              <span className="telegram-workspace-initial">{item.name[0]?.toUpperCase()}</span>
              <span className="telegram-row-name">
                {item.name}
                <small>
                  {item.bots.length
                    ? `${item.bots.length} bot${item.bots.length === 1 ? '' : 's'}`
                    : 'Add a bot in this workspace first'}
                </small>
              </span>
            </label>
          ))}
          <button
            className="button telegram-card-done"
            disabled={disabled}
            onClick={() => setView('list')}
          >
            Done
          </button>
        </div>
      ) : editingBot ? (
        <div className="telegram-workspace-editor">
          <p className="telegram-card-hint">Choose which bot replies in this workspace.</p>
          <div
            className="telegram-bot-options"
            role="group"
            aria-label={`Responding bot for ${workspace.name}`}
          >
            {[
              { id: null, name: 'Main bot', description: 'Follows this workspace’s main bot' },
              ...workspace.bots.map((bot) => ({
                id: bot.id,
                name: bot.name,
                description: bot.isMain ? 'Current main bot' : '',
              })),
            ].map((bot) => (
              <button
                key={bot.id ?? 'automatic'}
                className="telegram-bot-option"
                aria-pressed={selected.botId === bot.id}
                disabled={disabled}
                onClick={() => {
                  onChange(
                    selection.map((entry) =>
                      entry.workspaceId === workspace.id ? { ...entry, botId: bot.id } : entry,
                    ),
                  );
                  setView('list');
                }}
              >
                <span>
                  {bot.name}
                  {bot.description && <small>{bot.description}</small>}
                </span>
                {selected.botId === bot.id && <Check size={17} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <button
            className="text-button telegram-remove-workspace"
            disabled={disabled}
            onClick={() => {
              onChange(selection.filter((entry) => entry.workspaceId !== workspace.id));
              setView('list');
            }}
          >
            Remove workspace
          </button>
        </div>
      ) : added.length ? (
        <div className="telegram-workspace-list">
          {added.map((item) => {
            const access = selection.find((entry) => entry.workspaceId === item.id)!;
            return (
              <button
                className="telegram-workspace-row"
                key={item.id}
                disabled={disabled}
                aria-label={`Configure ${item.name}`}
                onClick={() => {
                  setWorkspaceId(item.id);
                  setView('bot');
                }}
              >
                <span className="telegram-workspace-initial">{item.name[0]?.toUpperCase()}</span>
                <span className="telegram-row-name">{item.name}</span>
                <span className="telegram-row-bot">
                  {access.botId
                    ? item.bots.find((bot) => bot.id === access.botId)?.name || 'Bot unavailable'
                    : 'Main bot'}
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="telegram-workspace-empty">
          <p>
            {workspaces.length
              ? 'Bring your workspaces into Telegram.'
              : 'Create a workspace in Mukai to get started.'}
          </p>
          {workspaces.length > 0 && (
            <button className="button" disabled={disabled} onClick={() => setView('add')}>
              <Plus size={17} /> Add workspaces
            </button>
          )}
        </div>
      )}
    </section>
  );
}
