import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import { RetryResponseButton } from './RetryResponseButton';
import { AIQueueNotice } from './AIQueueNotice';
import { TelegramSourceBadge } from '../../components/ui/TelegramSourceBadge';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  FileText,
  Info,
  LoaderCircle,
  MessageCirclePlus,
  SlidersHorizontal,
  X,
  ListTree,
} from 'lucide-react';
import type { Bot, ChatMessage, ProviderSettings } from '../../../../shared/ai';
import type { TrajectoryMessageStats } from '../../../../shared/trajectory';
import type { NotificationSource } from '../../../../shared/notifications';
import { isPursuitKickoff } from '../../../../shared/pursuits';
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
import { CONVERSATION_TITLE_LIMIT, type Conversation } from '../../../../shared/conversations';
import { ToolApprovalCards } from './ToolApprovals';
import { AskComposer } from './AskComposer';
import { useApprovals } from './approvalStore';
import { approvalBlocksConversation } from '../../../../shared/approvals';
import { useChatActivity } from './useChatActivity';
import { ChatActivityDrawer } from './ChatActivityDrawer';
import { BotChatComposer } from './BotChatComposer';
import { SteeringMessages } from './SteeringMessages';
import { useWorkDisclosure } from './useWorkDisclosure';
import { TrajectoryView } from './TrajectoryView';
import { TurnFooter } from './ChatStats';
import { useChatStats } from './useChatStats';
import { errorText } from '../../utils/errors';

type ChatView = 'Chat' | 'Trajectory' | 'Artifacts' | 'Run outcome';

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
  onOpenSource,
  run,
}: {
  bot?: Bot;
  bots: Bot[];
  conversation: Conversation;
  onNewConversation?: () => Promise<void>;
  providers: ProviderSettings[];
  onEdit?: () => void;
  onProviders: () => void;
  onBotChanged: (bot: Bot) => void;
  onOpenBot?: (id: string) => Promise<void>;
  onViewComputer?: () => void;
  onOpenSource?: (source: NotificationSource) => Promise<void>;
  run?: {
    id: string;
    active: boolean;
    controls: ReactNode;
    outcome: ReactNode;
    onBack: () => void;
    error?: string;
  };
}) {
  const isBotConversation = conversation.kind === 'bot';
  const requiresJoin = isBotConversation || !!run;
  const joinKey = `mukai.joined-bot-chat.${conversation.workspaceId}.${conversation.id}`;
  const [joined, setJoined] = useState(() => {
    try {
      return localStorage.getItem(joinKey) === '1';
    } catch {
      return false;
    }
  });
  const composerVisible = Boolean(bot && (!requiresJoin || joined));
  function joinChat() {
    setJoined(true);
    try {
      localStorage.setItem(joinKey, '1');
    } catch {
      /* Keep the composer open for this visit. */
    }
  }
  const chatId = (isBotConversation ? 'space:' : 'private:') + conversation.id;
  const chat = useChat(chatId, isBotConversation || Boolean(run?.active));
  const state = run?.active && !chat.busy ? { ...chat, busy: true } : chat;
  const firstUser = state.messages.find((message) => message.role === 'user');
  const kickoff =
    run && firstUser && (firstUser.requestId === run.id || isPursuitKickoff(firstUser.content))
      ? firstUser
      : undefined;
  const firstPrompt = firstUser?.content;
  const title = useMemo(() => {
    if (!firstPrompt || conversation.name.length < CONVERSATION_TITLE_LIMIT)
      return conversation.name;
    // The saved title may already have been cut before the header renders it.
    const prefix = conversation.name.replace(/\s+/g, ' ').trim();
    const prompt = firstPrompt.replace(/\s+/g, ' ').trim();
    return prompt.length > prefix.length &&
      prompt.startsWith(prefix) &&
      !/(?:…|\.\.\.)$/.test(prefix)
      ? `${conversation.name.trimEnd()}…`
      : conversation.name;
  }, [conversation.name, firstPrompt]);
  const activity = useChatActivity(conversation.id, state.messages, bots, bot?.id || '');
  const approvals = useApprovals();
  const hasRequests = approvals.pending.some((request) =>
    approvalBlocksConversation(request, conversation.id),
  );
  const participants = [...conversation.botIds]
    .sort()
    .map((id) => bots.find((item) => item.id === id))
    .filter((item): item is Bot => Boolean(item));
  const [creatingChat, setCreatingChat] = useState(false),
    [newChatError, setNewChatError] = useState('');
  async function createChat() {
    if (creatingChat || !onNewConversation) return;
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [view, setView] = useState<ChatView>('Chat');
  const views: ChatView[] = run
    ? ['Chat', 'Trajectory', 'Artifacts', 'Run outcome']
    : ['Chat', 'Trajectory'];
  const viewId = useId();
  const [review, setReview] = useState<{ changes: FileChangeSummary[]; selectedId: string } | null>(
    null,
  );
  const feed = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const provider = providers.find((provider) =>
    bot?.providerId ? provider.id === bot.providerId : provider.isDefault,
  );
  const model = bot?.model || provider?.defaultModel;
  const capabilities = modelInputCapabilities(
    bot ?? { model: null, supportsImages: null },
    provider,
  );
  const files = state.messages.flatMap((message) => message.attachments);
  const latestAssistant = [...state.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  const latestSettledAssistant = [...state.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.status !== 'streaming');
  const stats = useChatStats(conversation.id, state.loading, state.busy, latestAssistant);
  useEffect(() => {
    if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [state.messages, state.loading, bot?.id, view]);
  function send() {
    follow.current = true;
    if (run?.active) void chatStore.queue(chatId);
    else void chatStore.send(chatId);
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
  const saveMessage = useCallback(
    (message: ChatMessage) => {
      void chatStore.save(chatId, message.id, !message.saved);
    },
    [chatId],
  );
  return (
    <div
      ref={activity.layoutRef}
      className={`conversation-layout ${run ? 'pursuit-run-chat' : ''} ${activity.open && !detailsOpen ? 'has-chat-activity' : ''}`}
    >
      <div className="conversation-panels">
        <main className="conversation">
          <header className="conversation-header">
            <div className="conversation-heading bot-chat-heading">
              <div className="heading-identity">
                {run && (
                  <IconButton label="All runs" onClick={run.onBack}>
                    <ArrowLeft size={16} />
                  </IconButton>
                )}
                {isBotConversation ? (
                  <span className="bot-pair-avatars">
                    {participants.map((item) => (
                      <Avatar key={item.id} person={item.avatar} size="xs" />
                    ))}
                  </span>
                ) : (
                  <Avatar person={bot?.avatar || 'scout'} size="xs" />
                )}
                <h1 title={title}>{title}</h1>
              </div>
              <div className="header-actions">
                {run?.controls}
                {!isBotConversation && <BrowserToggle />}
                {!isBotConversation && !run && bot && onNewConversation && (
                  <IconButton
                    label={`New conversation with ${bot.name}`}
                    disabled={creatingChat}
                    onClick={() => void createChat()}
                  >
                    <MessageCirclePlus size={18} />
                  </IconButton>
                )}
                {!run && (
                  <IconButton
                    label={view === 'Artifacts' ? 'Back to chat' : 'Artifacts'}
                    className={view === 'Artifacts' ? 'is-on' : ''}
                    onClick={() => setView(view === 'Artifacts' ? 'Chat' : 'Artifacts')}
                  >
                    <FileText size={18} />
                  </IconButton>
                )}
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
                {bot && (
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
                )}
                {!isBotConversation && !run && bot && onEdit && (
                  <IconButton label={`Edit ${bot.name}`} onClick={onEdit}>
                    <SlidersHorizontal size={18} />
                  </IconButton>
                )}
              </div>
            </div>
            <div className="conversation-tabs" role="tablist" aria-label="Conversation views">
              {views.map((name) => {
                const active = view === name;
                return (
                  <button
                    key={name}
                    id={`${viewId}-${name.replace(' ', '-')}-tab`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`${viewId}-${name.replace(' ', '-')}-panel`}
                    className={active ? 'is-active' : ''}
                    onClick={() => setView(name)}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </header>
          {run?.error && (
            <p className="ai-alert" role="alert">
              {run.error}
            </p>
          )}
          {view === 'Run outcome' ? (
            <div
              id={`${viewId}-Run-outcome-panel`}
              role="tabpanel"
              aria-labelledby={`${viewId}-Run-outcome-tab`}
              className="ai-message-feed"
            >
              {run?.outcome}
            </div>
          ) : view === 'Artifacts' ? (
            <div
              id={`${viewId}-Artifacts-panel`}
              role={run ? 'tabpanel' : undefined}
              aria-labelledby={run ? `${viewId}-Artifacts-tab` : undefined}
              className="bot-chat-transcript"
            >
              <ArtifactsView
                conversationId={conversation.id}
                attachments={files}
                messages={state.messages}
              />
            </div>
          ) : (
            <>
              {view === 'Trajectory' && (
                <div
                  id={`${viewId}-Trajectory-panel`}
                  role="tabpanel"
                  aria-labelledby={`${viewId}-Trajectory-tab`}
                  className="bot-chat-transcript"
                >
                  <TrajectoryView
                    key={conversation.id}
                    conversationId={conversation.id}
                    messages={state.messages}
                    loading={state.loading}
                    busy={state.busy}
                  />
                </div>
              )}
              <div
                id={`${viewId}-Chat-panel`}
                role="tabpanel"
                aria-labelledby={`${viewId}-Chat-tab`}
                className="bot-chat-transcript"
                hidden={view === 'Trajectory'}
              >
                <div
                  ref={feed}
                  className={`ai-message-feed${state.loading ? ' is-loading' : ''}`}
                  role="log"
                  aria-label={`${conversation.name} chat`}
                  aria-busy={state.loading || state.busy}
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
                    <div className="ai-chat-empty ai-chat-loading" role="status">
                      <LoaderCircle className="is-spinning" size={24} />
                      <p>Loading your chat…</p>
                    </div>
                  ) : (
                    !state.messages.length && (
                      <div className="ai-chat-empty">
                        <Avatar person={bot?.avatar || 'scout'} size="lg" />
                        <h2>
                          {run
                            ? run.active
                              ? 'Starting this run…'
                              : 'No response was generated.'
                            : 'A good place to start.'}
                        </h2>
                        <p>
                          {run
                            ? bot
                              ? ''
                              : 'The owning bot is unavailable.'
                            : isBotConversation
                              ? 'Messages between these bots will appear here.'
                              : provider
                                ? `Talk to ${bot?.name}. Bring a question, an idea, or something you’re working on.`
                                : `Connect an AI provider to start talking with ${bot?.name}. Your bot is ready; it just needs a model.`}
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
                  {state.messages
                    .filter((message) => message.id !== kickoff?.id)
                    .map((message) => (
                      <MessageRow
                        key={message.id}
                        message={message}
                        bot={bot}
                        author={
                          isBotConversation
                            ? bots.find((item) => item.id === message.botId)
                            : undefined
                        }
                        isBotConversation={isBotConversation}
                        busy={state.busy}
                        stats={stats.get(message.id)}
                        latestTurn={message.id === latestSettledAssistant?.id}
                        canRetry={
                          message.requestId !== kickoff?.requestId &&
                          message.id === latestAssistant?.id &&
                          message.requestId ===
                            [...state.messages].reverse().find((turn) => turn.role === 'user')
                              ?.requestId
                        }
                        onReview={openReview}
                        onRetry={retryResponse}
                        onSave={run ? saveMessage : undefined}
                        onOpenSource={onOpenSource}
                      />
                    ))}
                  <AIQueueNotice conversationId={conversation.id} />
                </div>
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
              {requiresJoin && !joined && bot && (
                <div className="bot-chat-join">
                  <button className="bot-chat-join-pill" onClick={joinChat}>
                    <MessageCirclePlus size={15} /> Jump in the chat
                  </button>
                </div>
              )}
              {composerVisible && bot && (
                <BotChatComposer
                  bot={bot}
                  providers={providers}
                  conversationId={conversation.id}
                  chatId={chatId}
                  state={state}
                  stats={stats}
                  onSend={send}
                  onProviders={onProviders}
                  onBotChanged={onBotChanged}
                  newChatError={newChatError}
                  autoFocus={requiresJoin}
                />
              )}
            </>
          )}
        </main>
        {activity.open && !detailsOpen && (
          <ChatActivityDrawer
            data={activity}
            bots={bots}
            workspaceId={conversation.workspaceId}
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
        {detailsOpen && bot && (
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
            {!isBotConversation && onEdit && (
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
  stats,
  latestTurn,
  canRetry,
  onReview,
  onRetry,
  onSave,
  onOpenSource,
}: {
  message: ChatMessage;
  bot?: Bot;
  author?: Bot;
  isBotConversation: boolean;
  busy: boolean;
  stats?: TrajectoryMessageStats;
  latestTurn: boolean;
  canRetry: boolean;
  onReview: (changes: FileChangeSummary[], selectedId: string) => void;
  onRetry: (requestId: string) => void;
  onSave?: (message: ChatMessage) => void;
  onOpenSource?: (source: NotificationSource) => Promise<void>;
}) {
  const { time: formatTime } = useWorkspaceTime();
  const disclosure = useWorkDisclosure(message);
  const botAuthored = isBotConversation ? Boolean(message.botId) : message.role === 'assistant';
  return (
    <>
      <SteeringMessages message={message} collapsed={!disclosure.workExpanded} />
      <article className={`ai-message ai-message--${message.role}`}>
        <Avatar
          person={botAuthored ? author?.avatar || bot?.avatar || 'scout' : 'munashe'}
          size="sm"
        />
        <div className="ai-message-body">
          <div className="ai-message-meta">
            <strong>
              {botAuthored ? author?.name || message.authorName || bot?.name || 'Owner' : 'You'}
            </strong>
            <TelegramSourceBadge message={message} />
            {botAuthored && (
              <span className={`bot-badge bot-badge--${author?.avatar || bot?.avatar || 'scout'}`}>
                BOT
              </span>
            )}
            <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          </div>
          {message.role === 'assistant' && <ResponseActivity message={message} {...disclosure} />}
          {message.notificationSource && onOpenSource && (
            <NotificationSourceLink source={message.notificationSource} open={onOpenSource} />
          )}
          {message.role === 'assistant' && <FileChanges message={message} onReview={onReview} />}
          {message.role === 'user' && message.content && <MessageMarkdown text={message.content} />}
          {!!message.attachments.length && (
            <div className="ai-attachments">
              {message.attachments.map((file) => (
                <AttachmentCard attachment={file} key={file.id} />
              ))}
            </div>
          )}
          {['failed', 'stopped', 'interrupted'].includes(message.status) && (
            <div className="ai-response-status">
              <span>{message.error || 'Response stopped.'}</span>
              {canRetry && (
                <RetryResponseButton disabled={busy} onRetry={() => onRetry(message.requestId)} />
              )}
            </div>
          )}
          {message.role === 'assistant' && message.status !== 'streaming' && (
            <TurnFooter
              message={message}
              stats={stats}
              latest={latestTurn}
              onSave={onSave ? () => onSave(message) : undefined}
            />
          )}
        </div>
      </article>
    </>
  );
});

function NotificationSourceLink({
  source,
  open,
}: {
  source: NotificationSource;
  open: (source: NotificationSource) => Promise<void>;
}) {
  const [error, setError] = useState('');
  return (
    <div className="notification-source-link">
      <button
        type="button"
        className="text-button"
        title={source.name}
        onClick={() => {
          setError('');
          void open(source).catch((caught) => setError(errorText(caught)));
        }}
      >
        {source.runId ? 'Open original run' : 'Open original conversation'}{' '}
        <ArrowUpRight size={13} />
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
