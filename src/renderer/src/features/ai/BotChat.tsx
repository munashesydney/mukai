import { MainBotBadge } from '../../components/ui/MainBotBadge';
import { TelegramSourceBadge } from '../../components/ui/TelegramSourceBadge';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  FileText,
  Info,
  LoaderCircle,
  MessageCirclePlus,
  RotateCcw,
  SlidersHorizontal,
  X,
  ListTree,
} from 'lucide-react';
import type { Bot, ChatMessage, ProviderSettings } from '../../../../shared/ai';
import { inputCapabilityLabel, modelInputCapabilities } from '../../../../shared/modelCapabilities';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/IconButton';
import { AttachmentCard } from './AttachmentCard';
import { chatStore, useChat } from './chatStore';
import { ResponseActivity } from './ResponseActivity';
import { MessageMarkdown } from './MessageMarkdown';
import { ArtifactsView } from './ArtifactsView';
import type { FileChangeSummary } from '../../../../shared/fileChanges';
import { FileChanges } from './FileChanges';
import { DiffDrawer } from './DiffDrawer';
import { BrowserToggle } from '../browser/BrowserToggle';
import type { Conversation } from '../../../../shared/conversations';
import { ToolApprovalCards } from './ToolApprovals';
import { AskComposer } from './AskComposer';
import { useApprovals } from './approvalStore';
import { approvalBlocksConversation } from '../../../../shared/approvals';
import { useChatActivity } from './useChatActivity';
import { ChatActivityDrawer } from './ChatActivityDrawer';
import { BotChatComposer } from './BotChatComposer';
import { SteeringMessages } from './SteeringMessages';
import { useWorkDisclosure } from './useWorkDisclosure';
import { responseStatus } from './responseStatus';

export function BotChat({
  bot,
  bots,
  conversation,
  onNewConversation,
  providers,
  onEdit,
  onProviders,
  onBotChanged,
  onOpenBot,
  onViewComputer,
}: {
  bot: Bot;
  bots: Bot[];
  conversation: Conversation;
  onNewConversation: () => Promise<void>;
  providers: ProviderSettings[];
  onEdit: () => void;
  onProviders: () => void;
  onBotChanged: (bot: Bot) => void;
  onOpenBot?: (id: string) => Promise<void>;
  onViewComputer?: () => void;
}) {
  const isBotConversation = conversation.kind === 'bot';
  const joinKey = `mukai.joined-bot-chat.${conversation.workspaceId}.${conversation.id}`;
  const [joined, setJoined] = useState(() => {
    try {
      return localStorage.getItem(joinKey) === '1';
    } catch {
      return false;
    }
  });
  const composerVisible = !isBotConversation || joined;
  function joinChat() {
    setJoined(true);
    try {
      localStorage.setItem(joinKey, '1');
    } catch {
      /* Keep the composer open for this visit. */
    }
  }
  const chatId = (isBotConversation ? 'space:' : 'private:') + conversation.id;
  const state = useChat(chatId, isBotConversation);
  const activity = useChatActivity(conversation.id, state.messages, bots, bot.id);
  const approvals = useApprovals();
  const hasRequests = approvals.pending.some((request) =>
    approvalBlocksConversation(request, conversation.id),
  );
  const participants = [...conversation.botIds]
    .sort()
    .map((id) => bots.find((item) => item.id === id))
    .filter((item): item is Bot => Boolean(item));
  const title = isBotConversation ? participants.map((item) => item.name).join('/') : bot.name;
  const [creatingChat, setCreatingChat] = useState(false),
    [newChatError, setNewChatError] = useState('');
  async function createChat() {
    if (creatingChat) return;
    setCreatingChat(true);
    setNewChatError('');
    try {
      await onNewConversation();
    } catch (caught) {
      setNewChatError(
        caught instanceof Error ? caught.message : 'Could not create a conversation.',
      );
    } finally {
      setCreatingChat(false);
    }
  }
  const [filesOpen, setFilesOpen] = useState(false),
    [detailsOpen, setDetailsOpen] = useState(false);
  const [review, setReview] = useState<{ changes: FileChangeSummary[]; selectedId: string } | null>(
    null,
  );
  const feed = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const provider = providers.find((provider) =>
    bot.providerId ? provider.id === bot.providerId : provider.isDefault,
  );
  const model = bot.model || provider?.defaultModel;
  const capabilities = modelInputCapabilities(bot, provider);
  const files = state.messages.flatMap((message) => message.attachments);
  const latestAssistant = [...state.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  useEffect(() => {
    if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [state.messages, state.loading, bot.id]);
  function send() {
    follow.current = true;
    void chatStore.send(chatId);
  }
  const openReview = useCallback(
    (changes: FileChangeSummary[], selectedId: string) => setReview({ changes, selectedId }),
    [],
  );
  const retryResponse = useCallback(
    (requestId: string) => {
      follow.current = true;
      void chatStore.send(chatId, requestId);
    },
    [chatId],
  );
  return (
    <div
      ref={activity.layoutRef}
      className={`conversation-layout ${activity.open && !detailsOpen ? 'has-chat-activity' : ''}`}
    >
      <div className="conversation-panels">
        <main className="conversation">
          <header className="conversation-header conversation-header--minimal">
            <div className="conversation-heading">
              <div className="heading-identity">
                {isBotConversation ? (
                  <span className="bot-pair-avatars">
                    {participants.map((item) => (
                      <Avatar key={item.id} person={item.avatar} />
                    ))}
                  </span>
                ) : (
                  <Avatar person={bot.avatar} />
                )}
                <div>
                  <h1>
                    {title}
                    {!isBotConversation && bot.isMain && <MainBotBadge />}
                  </h1>
                  <p title={conversation.name}>{conversation.name}</p>
                </div>
              </div>
              <div className="header-actions">
                {!isBotConversation && <BrowserToggle />}
                {!isBotConversation && (
                  <IconButton
                    label={`New conversation with ${bot.name}`}
                    disabled={creatingChat}
                    onClick={() => void createChat()}
                  >
                    <MessageCirclePlus size={18} />
                  </IconButton>
                )}
                <IconButton
                  label={filesOpen ? 'Back to chat' : 'Artifacts'}
                  className={filesOpen ? 'is-on' : ''}
                  onClick={() => setFilesOpen(!filesOpen)}
                >
                  <FileText size={18} />
                </IconButton>
                {activity.available && (
                  <IconButton
                    label={
                      activity.open && !detailsOpen ? 'Hide chat activity' : 'Show chat activity'
                    }
                    className={activity.open && !detailsOpen ? 'is-on' : ''}
                    aria-expanded={activity.open && !detailsOpen}
                    aria-controls="chat-activity-drawer"
                    onClick={() => {
                      activity.setOpen(!activity.open || detailsOpen);
                      setDetailsOpen(false);
                    }}
                  >
                    <ListTree size={18} />
                  </IconButton>
                )}
                <IconButton
                  label="Bot details"
                  className={detailsOpen ? 'is-on' : ''}
                  onClick={() => {
                    setDetailsOpen(!detailsOpen);
                    activity.setOpen(false);
                  }}
                >
                  <Info size={18} />
                </IconButton>
                {!isBotConversation && (
                  <IconButton label={`Edit ${bot.name}`} onClick={onEdit}>
                    <SlidersHorizontal size={18} />
                  </IconButton>
                )}
              </div>
            </div>
          </header>
          {filesOpen ? (
            <ArtifactsView
              conversationId={conversation.id}
              attachments={files}
              messages={state.messages}
            />
          ) : (
            <>
              <div
                ref={feed}
                className="ai-message-feed"
                role="log"
                aria-label={`${title} chat`}
                aria-busy={state.busy}
                onScroll={() => {
                  if (feed.current)
                    follow.current =
                      feed.current.scrollHeight -
                        feed.current.scrollTop -
                        feed.current.clientHeight <
                      120;
                }}
              >
                {state.loading ? (
                  <div className="ai-chat-empty">
                    <LoaderCircle className="is-spinning" size={24} />
                    <p>Loading your chat…</p>
                  </div>
                ) : (
                  !state.messages.length && (
                    <div className="ai-chat-empty">
                      <Avatar person={bot.avatar} size="lg" />
                      <h2>A good place to start.</h2>
                      <p>
                        {isBotConversation
                          ? 'Messages between these bots will appear here.'
                          : provider
                            ? `Talk to ${bot.name}. Bring a question, an idea, or something you’re working on.`
                            : `Connect an AI provider to start talking with ${bot.name}. Your bot is ready; it just needs a model.`}
                      </p>
                      {!isBotConversation && !provider && (
                        <button className="button button--primary" onClick={onProviders}>
                          Configure a provider
                        </button>
                      )}
                    </div>
                  )
                )}
                {!composerVisible && state.error && (
                  <p className="ai-alert" role="alert">
                    {state.error}
                  </p>
                )}
                {state.messages.map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    bot={bot}
                    author={
                      isBotConversation ? bots.find((item) => item.id === message.botId) : undefined
                    }
                    isBotConversation={isBotConversation}
                    busy={state.busy}
                    canRetry={
                      composerVisible &&
                      message.id === latestAssistant?.id &&
                      (!isBotConversation ||
                        state.messages.some(
                          (turn) =>
                            turn.requestId === message.requestId &&
                            turn.role === 'user' &&
                            !turn.botId,
                        ))
                    }
                    onReview={openReview}
                    onRetry={retryResponse}
                  />
                ))}
              </div>
              {!composerVisible && hasRequests && (
                <div className="bot-conversation-requests">
                  <ToolApprovalCards conversationId={conversation.id} />
                  <AskComposer
                    conversationId={conversation.id}
                    onCancel={() => void chatStore.stop(chatId)}
                  >
                    {null}
                  </AskComposer>
                </div>
              )}
              {isBotConversation && !joined && (
                <div className="bot-chat-join">
                  <button className="bot-chat-join-pill" onClick={joinChat}>
                    <MessageCirclePlus size={15} /> Jump in the chat
                  </button>
                </div>
              )}
              {composerVisible && (
                <BotChatComposer
                  bot={bot}
                  providers={providers}
                  conversationId={conversation.id}
                  chatId={chatId}
                  state={state}
                  onSend={send}
                  onProviders={onProviders}
                  onBotChanged={onBotChanged}
                  newChatError={newChatError}
                  autoFocus={isBotConversation}
                />
              )}
            </>
          )}
        </main>
        {activity.open && !detailsOpen && (
          <ChatActivityDrawer
            data={activity}
            bots={bots}
            workspaceId={bot.workspaceId}
            onClose={() => activity.setOpen(false)}
            onReview={openReview}
            onOpenBot={onOpenBot}
            onViewComputer={onViewComputer}
          />
        )}
        {review && (
          <DiffDrawer
            changes={review.changes}
            selectedId={review.selectedId}
            onSelect={(selectedId) => setReview({ ...review, selectedId })}
            onClose={() => setReview(null)}
          />
        )}
        {detailsOpen && (
          <aside className="ai-details">
            <div className="ai-details-heading">
              <h2>About {bot.name}</h2>
              <IconButton label="Close bot details" onClick={() => setDetailsOpen(false)}>
                <X size={18} />
              </IconButton>
            </div>
            <Avatar person={bot.avatar} size="lg" />
            <h3>{bot.name}</h3>
            <p>{bot.role}</p>
            <dl>
              <dt>Workspace role</dt>
              <dd>{bot.isMain ? 'Main bot' : 'Workspace bot'}</dd>
              <dt>Reports to</dt>
              <dd>
                {bot.createdBy
                  ? bots.find((parent) => parent.id === bot.createdBy)?.name || 'Unavailable bot'
                  : 'You'}
              </dd>
              <dt>Provider</dt>
              <dd>{provider?.name || 'Not configured'}</dd>
              <dt>Model</dt>
              <dd>{model || 'Workspace default'}</dd>
              <dt>Model inputs</dt>
              <dd>{inputCapabilityLabel(capabilities)}</dd>
              <dt>Model context</dt>
              <dd>
                Messages from this conversation, within the model context limits. Other chats stay
                separate.
              </dd>
              <dt>Instructions</dt>
              <dd className="bot-instructions">{bot.instructions}</dd>
              <dt>Reasoning</dt>
              <dd>Shown when your selected model shares reasoning or a thinking summary.</dd>
            </dl>
            {!isBotConversation && (
              <button className="button" onClick={onEdit}>
                Edit bot
              </button>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

// One message row, memoized so composer keystrokes and stream deltas only
// re-render the message whose object identity actually changed in the store.
const MessageRow = memo(function MessageRow({
  message,
  bot,
  author,
  isBotConversation,
  busy,
  canRetry,
  onReview,
  onRetry,
}: {
  message: ChatMessage;
  bot: Bot;
  author?: Bot;
  isBotConversation: boolean;
  busy: boolean;
  canRetry: boolean;
  onReview: (changes: FileChangeSummary[], selectedId: string) => void;
  onRetry: (requestId: string) => void;
}) {
  const disclosure = useWorkDisclosure(message);
  const botAuthored = isBotConversation ? Boolean(message.botId) : message.role === 'assistant';
  return (
    <>
      <SteeringMessages message={message} collapsed={!disclosure.workExpanded} />
      <article className={`ai-message ai-message--${message.role}`}>
        <Avatar person={botAuthored ? author?.avatar || bot.avatar : 'munashe'} size="sm" />
        <div className="ai-message-body">
          <div className="ai-message-meta">
            <strong>{botAuthored ? author?.name || message.authorName || bot.name : 'You'}</strong>
            <TelegramSourceBadge message={message} />
            {botAuthored && (
              <span className={`bot-badge bot-badge--${author?.avatar || bot.avatar}`}>BOT</span>
            )}
            <time dateTime={message.createdAt}>
              {new Date(message.createdAt).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </time>
          </div>
          {message.role === 'assistant' && <ResponseActivity message={message} {...disclosure} />}
          {message.role === 'assistant' && <FileChanges message={message} onReview={onReview} />}
          {message.role === 'user' && message.content && <MessageMarkdown text={message.content} />}
          {!!message.attachments.length && (
            <div className="ai-attachments">
              {message.attachments.map((file) => (
                <AttachmentCard attachment={file} key={file.id} />
              ))}
            </div>
          )}
          {message.status === 'streaming' && (
            <div className="ai-response-status" role="status">
              <span className="typing-dots">
                <i />
                <i />
                <i />
              </span>
              {responseStatus(message)}…
            </div>
          )}
          {['failed', 'stopped', 'interrupted'].includes(message.status) && (
            <div className="ai-response-status">
              <span>{message.error || 'Response stopped.'}</span>
              {canRetry && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => onRetry(message.requestId)}
                >
                  <RotateCcw size={13} />
                  Retry response
                </button>
              )}
            </div>
          )}
        </div>
      </article>
    </>
  );
});
