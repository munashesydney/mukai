import { useEffect, useRef, useState } from 'react';
import {
  FileText,
  Info,
  LoaderCircle,
  MessageCirclePlus,
  Paperclip,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react';
import type { Bot, ProviderSettings } from '../../../../shared/ai';
import { ACCEPTED_FILES } from '../../../../shared/ai';
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

export function BotChat({
  bot,
  conversation,
  onNewConversation,
  providers,
  onEdit,
  onProviders,
}: {
  bot: Bot;
  conversation: Conversation;
  onNewConversation: () => Promise<void>;
  providers: ProviderSettings[];
  onEdit: () => void;
  onProviders: () => void;
}) {
  const chatId = 'private:' + conversation.id;
  const state = useChat(chatId);
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
  const fileInput = useRef<HTMLInputElement>(null),
    feed = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const provider = providers.find((provider) =>
    bot.providerId ? provider.id === bot.providerId : provider.isDefault,
  );
  const model = bot.model || provider?.defaultModel;
  const vision = bot.supportsImages ?? provider?.supportsImages ?? false;
  const blocked = state.files.some((file) => file.kind === 'image') && !vision;
  const files = state.messages.flatMap((message) => message.attachments);
  const latestAssistant = [...state.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  useEffect(() => {
    if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [state.messages, state.loading, bot.id]);
  function send() {
    if (provider && !blocked) {
      follow.current = true;
      void chatStore.send(chatId);
    }
  }
  return (
    <div className="conversation-layout">
      <main className="conversation">
        <header className="conversation-header conversation-header--minimal">
          <div className="conversation-heading">
            <div className="heading-identity">
              <Avatar person={bot.avatar} />
              <div>
                <h1>{bot.name}</h1>
                <p title={conversation.name}>{conversation.name}</p>
              </div>
            </div>
            <div className="header-actions">
              <BrowserToggle />
              <IconButton
                label={`New conversation with ${bot.name}`}
                disabled={creatingChat}
                onClick={() => void createChat()}
              >
                <MessageCirclePlus size={18} />
              </IconButton>
              <IconButton
                label={filesOpen ? 'Back to chat' : 'Artifacts'}
                className={filesOpen ? 'is-on' : ''}
                onClick={() => setFilesOpen(!filesOpen)}
              >
                <FileText size={18} />
              </IconButton>
              <IconButton
                label="Bot details"
                className={detailsOpen ? 'is-on' : ''}
                onClick={() => setDetailsOpen(!detailsOpen)}
              >
                <Info size={18} />
              </IconButton>
              <IconButton label={`Edit ${bot.name}`} onClick={onEdit}>
                <SlidersHorizontal size={18} />
              </IconButton>
            </div>
          </div>
        </header>
        {filesOpen ? (
          <ArtifactsView conversationId={conversation.id} attachments={files} />
        ) : (
          <>
            <div
              ref={feed}
              className="ai-message-feed"
              role="log"
              aria-label={`${bot.name} chat`}
              aria-busy={state.busy}
              onScroll={() => {
                if (feed.current)
                  follow.current =
                    feed.current.scrollHeight - feed.current.scrollTop - feed.current.clientHeight <
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
                      {provider
                        ? `Talk to ${bot.name}. Bring a question, an idea, or something you’re working on.`
                        : 'Connect a provider, then start a conversation with Scout or your own bot.'}
                    </p>
                    {!provider && (
                      <button className="button button--primary" onClick={onProviders}>
                        Configure a provider
                      </button>
                    )}
                  </div>
                )
              )}
              {state.messages.map((message) => (
                <article className={`ai-message ai-message--${message.role}`} key={message.id}>
                  <Avatar person={message.role === 'user' ? 'munashe' : bot.avatar} size="sm" />
                  <div className="ai-message-body">
                    <div className="ai-message-meta">
                      <strong>{message.role === 'user' ? 'You' : bot.name}</strong>
                      {message.role === 'assistant' && (
                        <span className={`bot-badge bot-badge--${bot.avatar}`}>BOT</span>
                      )}
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    {message.role === 'assistant' && <ResponseActivity message={message} />}
                    {message.role === 'assistant' && (
                      <FileChanges
                        message={message}
                        onReview={(changes, selectedId) => setReview({ changes, selectedId })}
                      />
                    )}
                    {message.role === 'user' && message.content && (
                      <MessageMarkdown text={message.content} />
                    )}
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
                        {message.activity?.some((activity) => activity.status === 'running')
                          ? 'Working with files…'
                          : message.content
                            ? 'Responding…'
                            : message.reasoning
                              ? `${bot.name} is thinking…`
                              : 'Waiting for the model…'}
                      </div>
                    )}
                    {['failed', 'stopped', 'interrupted'].includes(message.status) && (
                      <div className="ai-response-status">
                        <span>{message.error || 'Response stopped.'}</span>
                        {message.id === latestAssistant?.id && (
                          <button
                            className="text-button"
                            disabled={state.busy}
                            onClick={() => {
                              follow.current = true;
                              void chatStore.send(chatId, message.requestId);
                            }}
                          >
                            <RotateCcw size={13} />
                            Retry response
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <div className="composer-area ai-composer-area">
              {newChatError && (
                <p className="ai-alert" role="alert">
                  {newChatError}
                </p>
              )}
              {state.error && (
                <div className="ai-alert" role="alert">
                  {state.error}
                  {!state.busy && (
                    <button className="text-button" onClick={() => void chatStore.load(chatId)}>
                      Refresh chat
                    </button>
                  )}
                </div>
              )}
              {blocked && (
                <div className="ai-alert" role="alert">
                  This model is configured for text only. Remove the image or choose a vision model
                  before sending.
                  <button className="text-button" onClick={onEdit}>
                    Edit model settings
                  </button>
                </div>
              )}
              <div className="composer">
                {!!state.files.length && (
                  <div className="ai-attachments ai-pending-attachments">
                    {state.files.map((file) => (
                      <AttachmentCard
                        key={file.id}
                        attachment={file}
                        onRemove={
                          !state.busy && !state.uploading
                            ? () => void chatStore.removeFile(chatId, file.id)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                )}
                <textarea
                  rows={2}
                  aria-label={`Message ${bot.name}`}
                  placeholder={`Message ${bot.name}…`}
                  value={state.text}
                  maxLength={16000}
                  disabled={state.loading || state.busy}
                  onChange={(event) => chatStore.draft(chatId, event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-toolbar">
                  <div className="composer-actions">
                    <IconButton
                      label="Attach images or files"
                      disabled={state.busy || state.uploading || state.loading}
                      onClick={() => fileInput.current?.click()}
                    >
                      <Paperclip size={18} />
                    </IconButton>
                    <span className="ai-model-label" title={model}>
                      {state.uploading
                        ? 'Uploading & reading…'
                        : provider
                          ? model
                          : 'No provider configured'}
                    </span>
                  </div>
                  {state.busy ? (
                    <button
                      className="send-button ai-stop"
                      aria-label="Stop generation"
                      onClick={() => void chatStore.stop(chatId)}
                    >
                      <Square size={13} fill="currentColor" />
                      Stop
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="Send message"
                      disabled={
                        state.loading ||
                        state.uploading ||
                        blocked ||
                        !provider ||
                        (!state.text.trim() && !state.files.length)
                      }
                      onClick={send}
                    >
                      <Send size={16} />
                      <span>Send</span>
                    </button>
                  )}
                </div>
                <input
                  ref={fileInput}
                  className="visually-hidden"
                  type="file"
                  multiple
                  accept={ACCEPTED_FILES}
                  tabIndex={-1}
                  aria-label="Upload chat attachments"
                  onChange={(event) => {
                    void chatStore.upload(chatId, Array.from(event.target.files || []));
                    event.target.value = '';
                  }}
                />
              </div>
              <div className="composer-hint ai-composer-hint">
                <span>Enter to send · Shift + Enter for a new line</span>
                <span>4 files · 10 MB each · {vision ? 'Images enabled' : 'Text only'}</span>
              </div>
              {!provider && (
                <button className="text-button ai-configure-link" onClick={onProviders}>
                  Set up a provider in Settings
                </button>
              )}
            </div>
          </>
        )}
      </main>
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
          <p>{bot.description}</p>
          <dl>
            <dt>Provider</dt>
            <dd>{provider?.name || 'Not configured'}</dd>
            <dt>Model</dt>
            <dd>{model || 'Workspace default'}</dd>
            <dt>Images</dt>
            <dd>{vision ? 'Enabled' : 'Text only'}</dd>
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
          <button className="button" onClick={onEdit}>
            Edit bot
          </button>
        </aside>
      )}
    </div>
  );
}
