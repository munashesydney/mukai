import { useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import type { Bot, ProviderSettings } from '../../../../shared/ai';
import type { ChatState } from '../../models/chat';
import {
  acceptedAttachments,
  inputCapabilityLabel,
  modelInputCapabilities,
  supportsAttachment,
} from '../../../../shared/modelCapabilities';
import { modelContextWindow } from '../../../../shared/modelLimits';
import { IconButton } from '../../components/ui/IconButton';
import { AttachmentCard } from './AttachmentCard';
import { chatStore } from './chatStore';
import { FollowupQueue } from './FollowupQueue';
import { ToolApprovalCards, ApprovalModePicker } from './ToolApprovals';
import { AskComposer } from './AskComposer';
import { BotModelPicker } from './BotModelPicker';
import { ContextMeter } from './ContextMeter';

export function BotChatComposer({
  bot,
  providers,
  conversationId,
  chatId,
  state,
  onSend,
  onProviders,
  onBotChanged,
  newChatError = '',
  autoFocus = false,
}: {
  bot: Bot;
  providers: ProviderSettings[];
  conversationId: string;
  chatId: string;
  state: ChatState;
  onSend: () => void;
  onProviders: () => void;
  onBotChanged: (bot: Bot) => void;
  newChatError?: string;
  autoFocus?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [changingModel, setChangingModel] = useState(false);
  const provider = providers.find((provider) =>
    bot.providerId ? provider.id === bot.providerId : provider.isDefault,
  );
  const capabilities = modelInputCapabilities(bot, provider);
  const blocked = state.files.some((file) => !supportsAttachment(file.kind, capabilities));
  const blockedKinds = [
    ...new Set(
      state.files
        .filter((file) => !supportsAttachment(file.kind, capabilities))
        .map((file) => file.kind),
    ),
  ].join(', ');
  const latestAssistant = [...state.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  function send() {
    if (changingModel) return;
    if (!provider) return onProviders();
    if (!blocked) onSend();
  }
  return (
    <div className="composer-area ai-composer-area">
      <FollowupQueue chatId={chatId} state={state} />
      <ToolApprovalCards conversationId={conversationId} />
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
          This model does not support {blockedKinds} input. Remove these attachments or choose a
          model that supports them before sending.
          <button className="text-button" onClick={onProviders}>
            Configure models
          </button>
        </div>
      )}
      <AskComposer conversationId={conversationId} onCancel={() => void chatStore.stop(chatId)}>
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
            autoFocus={autoFocus}
            rows={2}
            aria-label={`Message ${bot.name}`}
            placeholder={state.busy ? 'Add a follow-up while working…' : `Message ${bot.name}…`}
            value={state.text}
            maxLength={16000}
            disabled={state.loading}
            onChange={(event) => chatStore.draft(chatId, event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (!files.length) return;

              // Keep ordinary text pastes intact, but turn copied files into pending attachments.
              event.preventDefault();
              void chatStore.upload(chatId, files);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-toolbar">
            <div className="composer-actions">
              <ApprovalModePicker />
              <IconButton
                label="Attach images or files"
                disabled={state.busy || state.uploading || state.loading}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={18} />
              </IconButton>
              {state.uploading ? (
                <span className="ai-model-label">Uploading & reading…</span>
              ) : (
                <BotModelPicker
                  bot={bot}
                  providers={providers}
                  disabled={state.busy || state.loading}
                  onSelected={onBotChanged}
                  onSaving={setChangingModel}
                  onProviders={onProviders}
                />
              )}
              <ContextMeter
                usage={latestAssistant?.contextUsage}
                window={modelContextWindow(bot, provider)}
                onConfigure={onProviders}
              />
            </div>
            {state.busy ? (
              <div className="followup-send-actions">
                <button
                  className="send-button"
                  aria-label="Queue follow-up"
                  title="Queue follow-up"
                  disabled={state.submittingFollowup || !state.text.trim()}
                  onClick={send}
                >
                  <ArrowUp size={18} />
                </button>
                <button
                  className="send-button ai-stop"
                  aria-label="Stop generation"
                  onClick={() => void chatStore.stop(chatId)}
                >
                  <Square size={13} fill="currentColor" />
                </button>
              </div>
            ) : (
              <button
                className="send-button"
                aria-label="Send message"
                disabled={
                  state.loading ||
                  changingModel ||
                  state.uploading ||
                  blocked ||
                  (!state.text.trim() && !state.files.length)
                }
                onClick={send}
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            multiple
            accept={acceptedAttachments(capabilities)}
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
          <span>
            Paste files with Ctrl/Cmd + V · 4 files · 10 MB each ·{' '}
            {inputCapabilityLabel(capabilities)}
          </span>
        </div>
        {!provider && (
          <button className="text-button ai-configure-link" onClick={onProviders}>
            Set up a provider in Settings
          </button>
        )}
      </AskComposer>
    </div>
  );
}
