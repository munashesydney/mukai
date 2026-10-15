import { useContext, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronRight, FileDiff, Globe, LoaderCircle, X } from 'lucide-react';
import type { Bot } from '../../../../shared/ai';
import type { FileChangeSummary } from '../../../../shared/fileChanges';
import { IconButton } from '../../components/ui/IconButton';
import { Avatar } from '../../components/ui/Avatar';
import { chatActivityService } from '../../services/chatActivityService';
import { useBrowserPanel } from '../browser/useBrowserPanel';
import { ConversationNavigation } from './ConversationNavigation';
import { useBotConversations } from './useBotConversations';
import { ConversationStatus } from './ConversationStatus';
import { ChangeCounts } from './FileChanges';
import { ArtifactCard } from './ArtifactsView';
import type { useChatActivity } from './useChatActivity';
import '../../styles/chatActivity.css';

function ActivitySection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (!count) return null;
  return (
    <section className="chat-activity-section" aria-label={title}>
      <h3>
        {title}
        <span>{count}</span>
      </h3>
      <div className="chat-activity-rows">{children}</div>
    </section>
  );
}

export function ChatActivityDrawer({
  data,
  bots,
  workspaceId,
  onClose,
  onReview,
  onOpenBot,
  onViewComputer,
}: {
  data: ReturnType<typeof useChatActivity>;
  bots: Bot[];
  workspaceId: string;
  onClose: () => void;
  onReview: (changes: FileChangeSummary[], selectedId: string) => void;
  onOpenBot?: (id: string) => Promise<void>;
  onViewComputer?: () => void;
}) {
  const navigate = useContext(ConversationNavigation);
  const browser = useBrowserPanel();
  const pairs = useBotConversations(workspaceId, 'bot');
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  async function openOutput(id: string, conversationId: string) {
    setBusy(id);
    setError('');
    try {
      const result = await chatActivityService.openOutput(conversationId, id);
      if (result.guest) onViewComputer?.();
      else if (result.tab && browser) {
        const tab = result.tab;
        browser.setTabs((tabs) => [...tabs.filter((item) => item.id !== tab.id), tab]);
        browser.setSelected(tab.id);
        browser.setVisible(true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open output.');
    } finally {
      setBusy('');
    }
  }
  return (
    <aside className="chat-activity-drawer" id="chat-activity-drawer" aria-label="Chat activity">
      <div className="chat-activity-heading">
        <div>
          <h2>Chat activity</h2>
          <p>Made in this conversation</p>
        </div>
        <IconButton label="Close chat activity" onClick={onClose}>
          <X size={17} />
        </IconButton>
      </div>
      {data.working && (
        <p className="chat-activity-progress" role="status">
          <LoaderCircle size={14} className="is-spinning" /> Activity updates as the bot works
        </p>
      )}
      <ActivitySection title="Bots" count={data.delegated.length + data.spawned.length}>
        {data.delegated.map((item) => {
          const conversation = pairs.conversations.find(
            (value) => value.id === item.conversationId,
          );
          const participants = (conversation?.botIds || [data.botId, item.botId])
            .map((id) => bots.find((bot) => bot.id === id))
            .filter((bot): bot is Bot => Boolean(bot));
          return (
            <button
              key={item.conversationId}
              className="chat-activity-row"
              disabled={!navigate}
              onClick={() => navigate?.(item.conversationId)}
            >
              <span className="bot-pair-avatars">
                {participants.map((bot) => (
                  <Avatar key={bot.id} person={bot.avatar} size="xs" />
                ))}
              </span>
              <span className="chat-activity-row-copy">
                <strong>
                  {participants.length
                    ? participants.map((bot) => bot.name).join('/')
                    : item.botName}
                </strong>
                <small>{conversation?.name || 'Bot conversation'}</small>
              </span>
              <ConversationStatus
                chatId={`space:${item.conversationId}`}
                updatedAt={conversation?.updatedAt || ''}
                isWorking={conversation?.isWorking}
              >
                <ChevronRight size={14} className="chat-activity-row-end" />
              </ConversationStatus>
            </button>
          );
        })}
        {data.spawned.map((bot) => (
          <button
            key={bot.id}
            className="chat-activity-row"
            disabled={!onOpenBot || Boolean(busy)}
            onClick={() => {
              setBusy(bot.id);
              setError('');
              void onOpenBot?.(bot.id)
                .catch((caught) =>
                  setError(caught instanceof Error ? caught.message : 'Could not open bot.'),
                )
                .finally(() => setBusy(''));
            }}
          >
            <Avatar person={bot.avatar} size="xs" />
            <span className="chat-activity-row-copy">
              <strong>{bot.name}</strong>
              <small>{bot.role}</small>
            </span>
            <ChevronRight size={14} className="chat-activity-row-end" />
          </button>
        ))}
      </ActivitySection>
      <ActivitySection title="Links" count={data.outputs.length}>
        {data.outputs.map((output) => (
          <a
            key={output.id}
            className="chat-activity-row"
            href={output.url}
            target="_blank"
            rel="noreferrer"
            title={output.url}
            onClick={(event) => {
              if (window.mukai || output.computer === 'qemu') {
                event.preventDefault();
                if (!busy) void openOutput(output.id, data.conversationId);
              }
            }}
          >
            <Globe size={17} />
            <span className="chat-activity-row-copy">
              <strong>
                {new URL(output.url).host}
                {new URL(output.url).pathname !== '/' ? new URL(output.url).pathname : ''}
              </strong>
              <small>
                <span
                  className={`chat-activity-dot ${output.status === 'running' ? 'is-running' : ''}`}
                />
                {output.status === 'running'
                  ? 'Running'
                  : output.status === 'unavailable'
                    ? 'Not running in this session'
                    : 'Server stopped'}
              </small>
            </span>
            {busy === output.id ? (
              <LoaderCircle size={14} className="is-spinning" />
            ) : (
              <ArrowUpRight size={14} className="chat-activity-row-end" />
            )}
          </a>
        ))}
      </ActivitySection>
      <ActivitySection title="Outputs" count={data.artifacts.length}>
        {data.artifacts.map((artifact) => (
          <ArtifactCard key={artifact.id} artifact={artifact} compact />
        ))}
      </ActivitySection>
      <ActivitySection title="Changes" count={data.changes.length}>
        {data.changes.map((change) => (
          <button
            key={change.id}
            className="chat-activity-row"
            title={change.path}
            onClick={() => onReview(data.changes, change.id)}
          >
            <FileDiff size={17} />
            <span className="chat-activity-row-copy">
              <strong>{change.path.split(/[\\/]/).at(-1)}</strong>
              <small>{change.path}</small>
            </span>
            <ChangeCounts added={change.added} removed={change.removed} />
          </button>
        ))}
        <p className="chat-activity-footnote">Latest saved edit for each file</p>
      </ActivitySection>
      {(error || data.error) && (
        <p className="chat-activity-error" role="alert">
          {error || data.error}
        </p>
      )}
    </aside>
  );
}
