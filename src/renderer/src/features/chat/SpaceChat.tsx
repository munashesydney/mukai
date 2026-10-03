import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Send, Square } from 'lucide-react';
import type { Bot, ProviderSettings } from '../../../../shared/ai';
import type { Conversation } from '../../../../shared/conversations';
import type { FileChangeSummary } from '../../../../shared/fileChanges';
import { botHandle, mentionedBot } from '../../../../shared/mentions';
import { Avatar } from '../../components/ui/Avatar';
import { MessageActions } from './MessageActions';
import { chatStore, useChat } from '../ai/chatStore';
import { ResponseActivity } from '../ai/ResponseActivity';
import { MessageMarkdown } from '../ai/MessageMarkdown';
import { FileChanges } from '../ai/FileChanges';
import { DiffDrawer } from '../ai/DiffDrawer';
import { ArtifactsView } from '../ai/ArtifactsView';
import { errorText } from '../../utils/errors';
import { ContextMeter } from '../ai/ContextMeter';
import { modelContextWindow } from '../../../../shared/modelLimits';

export function SpaceChat({
  space,
  bots,
  tab,
  savedOpen,
  onCloseSaved,
  providers,
  onProviders,
}: {
  space: Conversation;
  bots: Bot[];
  tab: string;
  savedOpen: boolean;
  onCloseSaved: () => void;
  providers: ProviderSettings[];
  onProviders: () => void;
}) {
  const id = 'space:' + space.id,
    state = useChat(id);
  const members = bots.filter((bot) => space.botIds.includes(bot.id));
  const [selectedBot, setSelectedBot] = useState<string | null>(null),
    [mentionError, setMentionError] = useState('');
  const [review, setReview] = useState<{ changes: FileChangeSummary[]; selectedId: string } | null>(
    null,
  );
  const feed = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    input = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  useEffect(() => {
    if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [state.messages, tab, savedOpen]);
  function send() {
    try {
      const botId = mentionedBot(state.text, members, selectedBot);
      setMentionError('');
      follow.current = true;
      void chatStore.send(id, undefined, botId);
    } catch (caught) {
      setMentionError(errorText(caught));
    }
  }
  const messages = savedOpen ? state.messages.filter((message) => message.saved) : state.messages;
  const latestAssistant = [...state.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  const latestUser = [...state.messages].reverse().find((message) => message.role === 'user');
  const respondingBot = members.find(
    (bot) =>
      bot.id === (state.busy ? latestAssistant?.botId : selectedBot || latestAssistant?.botId),
  );
  const provider = providers.find((item) =>
    respondingBot?.providerId ? item.id === respondingBot.providerId : item.isDefault,
  );
  return (
    <>
      {savedOpen && (
        <div className="saved-view-heading">
          <h2>Saved messages</h2>
          <button className="button button--small" onClick={onCloseSaved}>
            Back to messages
          </button>
        </div>
      )}
      {tab === 'Artifacts' && !savedOpen ? (
        <ArtifactsView
          conversationId={space.id}
          attachments={state.messages.flatMap((message) => message.attachments)}
        />
      ) : (
        <>
          <div
            className="ai-message-feed"
            ref={feed}
            role="log"
            aria-label={`${space.name} messages`}
            aria-busy={state.busy}
            onScroll={() => {
              const element = feed.current;
              if (element)
                follow.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 120;
            }}
          >
            {state.loading ? (
              <p className="ai-caption">
                <LoaderCircle className="is-spinning" size={18} /> Loading messages…
              </p>
            ) : (
              !messages.length && (
                <div className="ai-chat-empty">
                  <h2>{savedOpen ? 'No saved messages yet.' : 'A space for your next idea.'}</h2>
                  <p>
                    {savedOpen
                      ? 'Hover over a message and use its bookmark to save it here.'
                      : members.length
                        ? 'Write a message, or mention a bot with @ to ask for a response.'
                        : 'Messages in this space are saved here.'}
                  </p>
                </div>
              )
            )}
            {messages.map((message) => {
              const bot = bots.find((bot) => bot.id === message.botId);
              return (
                <article className={`ai-message ai-message--${message.role}`} key={message.id}>
                  <Avatar
                    person={message.role === 'user' ? 'munashe' : bot?.avatar || 'scout'}
                    size="sm"
                  />
                  <div className="ai-message-body">
                    <div className="ai-message-meta">
                      <strong>
                        {message.role === 'user' ? 'You' : bot?.name || message.authorName || 'Bot'}
                      </strong>
                      {message.role === 'assistant' && <span className="bot-badge">BOT</span>}
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    {message.role === 'assistant' ? (
                      <>
                        <ResponseActivity message={message} />
                        <FileChanges
                          message={message}
                          onReview={(changes, selectedId) => setReview({ changes, selectedId })}
                        />
                      </>
                    ) : (
                      <MessageMarkdown text={message.content} />
                    )}
                    {message.status === 'streaming' && (
                      <p className="ai-response-status" role="status">
                        {bot?.name || 'Bot'} is responding…
                      </p>
                    )}
                    {['failed', 'stopped', 'interrupted'].includes(message.status) && (
                      <div className="ai-response-status">
                        <span>{message.error || 'Response stopped.'}</span>
                        {message.id === latestAssistant?.id &&
                          message.requestId === latestUser?.requestId && (
                            <button
                              className="text-button"
                              disabled={state.busy}
                              onClick={() =>
                                void chatStore.send(id, message.requestId, message.botId)
                              }
                            >
                              Retry response
                            </button>
                          )}
                      </div>
                    )}
                    <MessageActions
                      text={message.content}
                      saved={Boolean(message.saved)}
                      onSave={() => void chatStore.save(id, message.id, !message.saved)}
                    />
                  </div>
                </article>
              );
            })}
          </div>
          {!savedOpen && (
            <div className="composer-area ai-composer-area">
              {(state.error || mentionError) && (
                <div className="ai-alert" role="alert">
                  {mentionError || state.error}
                  <button className="text-button" onClick={() => void chatStore.load(id)}>
                    Refresh messages
                  </button>
                </div>
              )}
              <div className="composer space-composer">
                <textarea
                  ref={input}
                  rows={2}
                  maxLength={16000}
                  aria-label={`Message ${space.name}`}
                  placeholder={
                    members.length
                      ? `Message ${space.name} · @mention a bot…`
                      : `Message ${space.name}…`
                  }
                  disabled={state.loading}
                  value={state.text}
                  onChange={(event) => {
                    chatStore.draft(id, event.target.value);
                    const cursor = event.target.selectionStart;
                    const match = event.target.value
                      .slice(0, cursor)
                      .match(/(?:^|\s)@([\p{L}\p{N}_-]*)$/u);
                    setMentionQuery(match ? match[1].toLowerCase() : null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setMentionQuery(null);
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      setMentionQuery(null);
                      send();
                    }
                  }}
                />
                {mentionQuery !== null && members.length > 0 && (
                  <div className="space-mention-list" aria-label="Mention a bot">
                    {members
                      .filter((bot) => botHandle(bot).includes(mentionQuery))
                      .map((bot) => (
                        <button
                          type="button"
                          key={bot.id}
                          onClick={() => {
                            const cursor = input.current?.selectionStart ?? state.text.length;
                            const before = state.text
                              .slice(0, cursor)
                              .replace(/@[\p{L}\p{N}_-]*$/u, '@' + botHandle(bot) + ' ');
                            chatStore.draft(id, before + state.text.slice(cursor));
                            setSelectedBot(bot.id);
                            setMentionQuery(null);
                            input.current?.focus();
                          }}
                        >
                          <Avatar person={bot.avatar} size="xs" />
                          <span>
                            {bot.name}
                            <small>{bot.description}</small>
                          </span>
                        </button>
                      ))}
                  </div>
                )}
                <div className="composer-toolbar">
                  <div className="composer-actions">
                    <span className="ai-caption">
                      {members.length
                        ? 'Mention one bot to get a response'
                        : 'No bots in this space'}
                    </span>
                    {respondingBot && (
                      <ContextMeter
                        usage={
                          latestAssistant?.botId === respondingBot.id
                            ? latestAssistant.contextUsage
                            : undefined
                        }
                        window={modelContextWindow(respondingBot, provider)}
                        onConfigure={onProviders}
                      />
                    )}
                  </div>
                  {state.busy ? (
                    <button
                      className="send-button ai-stop"
                      aria-label="Stop generation"
                      onClick={() => void chatStore.stop(id)}
                    >
                      <Square size={13} fill="currentColor" />
                      Stop
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="Send message"
                      disabled={state.loading || !state.text.trim()}
                      onClick={send}
                    >
                      <Send size={16} />
                      Send
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-hint">Enter to send · Shift + Enter for a new line</div>
            </div>
          )}
        </>
      )}
      {review && (
        <DiffDrawer
          {...review}
          onSelect={(selectedId) => setReview({ ...review, selectedId })}
          onClose={() => setReview(null)}
        />
      )}
    </>
  );
}
