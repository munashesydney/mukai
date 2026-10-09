import { Checkbox } from '../../components/ui/Checkbox';
import { useCallback, useEffect, useState } from 'react';
import { Check, Users } from 'lucide-react';
import type { Bot } from '../../../../shared/ai';
import type { ToolAssignment } from '../../../../shared/toolAssignments';
import { toolService } from '../../services/toolService';
import { errorText } from '../../utils/errors';
import { Avatar } from '../../components/ui/Avatar';

export function ToolAssignments({
  workspaceId,
  bots,
  toolId,
  shared = false,
}: {
  workspaceId: string;
  bots: Bot[];
  toolId: string;
  shared?: boolean;
}) {
  const [items, setItems] = useState<ToolAssignment[]>([]),
    [error, setError] = useState(''),
    [pending, setPending] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setItems(await toolService.assignments(workspaceId));
    setError('');
  }, [workspaceId]);
  const botIds = bots.map((bot) => bot.id).join(',');
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void toolService
      .assignments(workspaceId)
      .then((value) => {
        if (alive) setItems(value);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, toolId, botIds]);
  async function toggle(bot: Bot, enabled: boolean) {
    setPending(bot.id);
    setError('');
    try {
      await toolService.assign(workspaceId, bot.id, toolId, enabled);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  }
  return (
    <section className="tool-detail-section tool-assignments">
      <div className="assignment-heading">
        <Users size={18} />
        <h2>Bot assignments</h2>
      </div>
      <p>
        {toolId === 'manage_bot'
          ? 'Required for every bot. The main bot has all actions. Sub-bots can list, inspect, and message bots; delegated sub-bot runs can only list and inspect.'
          : shared
            ? 'Shared with every bot in this workspace.'
            : 'Choose which bots can use this tool. Changes apply to their next tool call.'}
      </p>
      {error && (
        <p className="ai-alert" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => void refresh().catch((e) => setError(errorText(e)))}
          >
            Retry
          </button>
        </p>
      )}
      {loading ? (
        <p className="ai-caption">Loading assignments…</p>
      ) : (
        <div className="assignment-list">
          {bots.map((bot) => {
            const enabled =
              shared ||
              Boolean(
                items.find((item) => item.botId === bot.id && item.toolId === toolId)?.enabled,
              );
            const parent = bots.find((item) => item.id === bot.createdBy);
            return (
              <label className={`assignment-row ${enabled ? 'is-assigned' : ''}`} key={bot.id}>
                <Avatar person={bot.avatar} size="sm" />
                <span className="assignment-identity">
                  <strong>{bot.name}</strong>
                  <small>
                    {bot.isMain
                      ? 'Main bot'
                      : parent
                        ? `Created by ${parent.name}`
                        : 'Workspace bot'}
                  </small>
                </span>
                <span className="assignment-status">
                  {pending === bot.id ? (
                    'Saving…'
                  ) : enabled ? (
                    <>
                      <Check size={13} />{' '}
                      {toolId === 'manage_bot'
                        ? bot.isMain
                          ? 'All actions'
                          : 'Limited actions'
                        : 'Assigned'}
                    </>
                  ) : (
                    'Not assigned'
                  )}
                </span>
                <Checkbox
                  aria-label={`Assign ${bot.name}`}
                  checked={enabled}
                  disabled={shared || loading || Boolean(pending)}
                  onChange={(event) => void toggle(bot, event.target.checked)}
                />
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
