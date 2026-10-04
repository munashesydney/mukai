import { ArrowUpRight, Hand, MessageCircle, Sparkles, Target } from 'lucide-react';
import type { Bot } from '../../../../shared/ai';
import type { ToolApproval } from '../../../../shared/approvals';
import { Avatar } from '../../components/ui/Avatar';
import { approvalStore, useApprovals } from './approvalStore';

export function PendingApprovalsPage({
  bot,
  onOpen,
}: {
  bot: Bot;
  onOpen: (request: ToolApproval) => void;
}) {
  const state = useApprovals();
  const pending = state.pending.filter((request) => request.botId === bot.id);
  const groups = new Map<string, ToolApproval[]>();
  for (const request of pending) {
    const group = groups.get(request.conversationId) || [];
    group.push(request);
    groups.set(request.conversationId, group);
  }
  const chats = groups.size;
  return (
    <main className="conversation pending-approvals-page">
      <header className="pending-approvals-header">
        <div className="pending-approvals-owner">
          <Avatar person={bot.avatar} size="sm" />
          <span>{bot.name}</span>
        </div>
        <span className="settings-eyebrow">APPROVALS</span>
        <h1>
          Pending Approvals<span>{pending.length}</span>
        </h1>
        <p>
          {pending.length
            ? `${bot.name} is waiting on you in ${chats} ${chats === 1 ? 'conversation' : 'conversations'}. Open a request to review and continue the work.`
            : 'All caught up. Your bot has no pending approvals.'}
        </p>
      </header>
      <div className="pending-approvals-content">
        {state.error && (
          <p className="ai-alert" role="alert">
            {state.error}
            <button className="text-button" onClick={() => void approvalStore.refresh()}>
              Refresh approvals
            </button>
          </p>
        )}
        {!state.loaded ? (
          <p className="ai-caption">Loading approvals…</p>
        ) : !pending.length ? (
          <div className="pending-approvals-empty">
            <Sparkles size={30} />
            <h2>A clear runway.</h2>
            <p>New requests will appear here whenever {bot.name} needs your approval.</p>
          </div>
        ) : (
          <div className="pending-approval-grid">
            {[...groups.values()].map((requests) => {
              const request = requests[0];
              const grouped = requests.length > 1;
              const pursuit = request.target?.kind === 'pursuit_run';
              const Icon = pursuit ? Target : MessageCircle;
              const input =
                request.input && typeof request.input === 'object'
                  ? (request.input as Record<string, unknown>)
                  : {};
              const action =
                typeof input.action === 'string' ? input.action.replaceAll('_', ' ') : 'Tool call';
              const detail = ['path', 'command', 'url', 'query']
                .map((key) => input[key])
                .find((value) => typeof value === 'string') as string | undefined;
              return (
                <button
                  className="pending-approval-tile"
                  key={request.conversationId}
                  onClick={() => onOpen(request)}
                  aria-label={`Open ${requests.length} ${grouped ? 'approvals' : 'approval'} in ${request.target?.name || 'conversation'}`}
                >
                  <Hand size={17} className="pending-approval-tile-icon" />
                  <div className="pending-approval-tile-body">
                    <div className="pending-approval-tile-title">
                      <h2>
                        {grouped
                          ? request.target?.name || 'Conversation'
                          : request.toolName.replaceAll('_', ' ')}
                      </h2>
                      <span>{grouped ? `${requests.length} approvals` : action}</span>
                    </div>
                    {grouped ? (
                      <div className="pending-approval-tools">
                        {requests.map((item) => (
                          <span key={item.id}>{item.toolName.replaceAll('_', ' ')}</span>
                        ))}
                      </div>
                    ) : (
                      detail && <code title={detail}>{detail}</code>
                    )}
                    <div className="pending-approval-tile-context">
                      <Icon size={15} />
                      <span>
                        {grouped ? 'Pending tool calls' : request.target?.name || 'Conversation'}
                        <small>
                          {pursuit
                            ? 'Pursuit run'
                            : request.target?.kind === 'space'
                              ? 'Space'
                              : 'Private chat'}
                        </small>
                      </span>
                    </div>
                  </div>
                  <time dateTime={request.createdAt}>
                    {new Date(request.createdAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </time>
                  <ArrowUpRight size={16} className="pending-approval-tile-arrow" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
