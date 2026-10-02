import { randomUUID } from 'node:crypto';
import { streamText, type ModelMessage, type UserContent } from 'ai';
import type { ChatInput, ChatEvent, MessageStatus } from '../../shared/ai';
import type { BotRecord } from '../models/entities';
import { MessageRepository } from '../repositories/messageRepository';
import { ProviderService, safeProviderError } from './providerService';
import { AttachmentService } from './attachmentService';
import { ApiError } from '../config';

interface Generation {
  controller: AbortController;
  content: string;
  assistantId: string;
  reason: 'stopped' | 'interrupted';
  done: Promise<void>;
}
export interface ChatOutput {
  start(): void;
  emit(event: ChatEvent): void;
  onDisconnect(callback: () => void): () => void;
  end(): void;
}
export class ChatService {
  private active = new Map<string, Generation>();
  constructor(
    private messages: MessageRepository,
    private providers: ProviderService,
    private attachments: AttachmentService,
  ) {}
  initialize() {
    this.messages.interruptStreaming(
      'The server restarted before this response finished. You can retry.',
    );
  }
  busy(id: string) {
    return this.active.has(id);
  }
  history(id: string) {
    if (!this.busy(id))
      this.messages.interruptStreaming('This response did not finish saving. You can retry.', id);
    return this.messages.history(id);
  }
  stop(id: string) {
    const active = this.active.get(id);
    if (active) {
      active.reason = 'stopped';
      active.controller.abort();
    }
  }
  async shutdown() {
    for (const active of this.active.values()) {
      active.controller.abort();
    }
    await Promise.all([...this.active.values()].map((active) => active.done));
  }
  private context(botId: string, vision: boolean): ModelMessage[] {
    // The pending assistant is excluded. Ten persisted messages include the current user.
    const rows = this.messages.context(botId, 10);
    return rows.map((row) => {
      if (row.role === 'assistant')
        return { role: 'assistant' as const, content: String(row.content) };
      const content: UserContent = [
        { type: 'text', text: String(row.content) || 'Please review the attached files.' },
      ];
      for (const file of this.attachments.forMessage(row.id)) {
        if (file.kind === 'image' && vision)
          content.push({
            type: 'file',
            data: this.attachments.bytes(file),
            mediaType: String(file.mediaType),
          });
        else
          content.push({
            type: 'text',
            text:
              file.kind === 'text'
                ? `Attached document: ${String(file.name)}\n<document>\n${String(file.extractedText)}\n</document>`
                : `[An image named ${String(file.name)} was attached previously; this text-only model cannot view it.]`,
          });
      }
      return { role: 'user' as const, content };
    });
  }
  async respond(bot: BotRecord, value: ChatInput, output: ChatOutput) {
    const botId = String(bot.id);
    if (this.busy(botId))
      throw new ApiError(409, 'This bot is already responding. Stop it or wait for it to finish.');
    const config = this.providers.resolve(bot);
    const existingUser = this.messages.forRequest(botId, value.requestId, 'user');
    let userId: string, assistantId: string;
    if (existingUser) {
      userId = String(existingUser.id);
      const assistant = this.messages.forRequest(botId, value.requestId, 'assistant')!;
      assistantId = String(assistant.id);
      if (assistant.status === 'complete') {
        output.start();
        output.emit({
          type: 'start',
          user: this.messages.message(userId),
          assistant: this.messages.message(assistantId),
        });
        output.emit({ type: 'done', message: this.messages.message(assistantId) });
        output.end();
        return;
      }
      if (this.messages.latestUserId(botId) !== userId)
        throw new ApiError(
          409,
          'Only the most recent response can be retried. Send a new message instead.',
        );
      const previousFiles = this.attachments.forMessage(userId);
      if (!config.vision && previousFiles.some((file) => file.kind === 'image'))
        throw new ApiError(400, 'Choose a vision model before retrying this image message.');
      this.messages.reset(assistantId);
    } else {
      if (!value.text && !value.attachmentIds.length)
        throw new ApiError(400, 'Write a message or attach a file.');
      const files = this.attachments.select(value.attachmentIds, botId, config.vision);
      userId = randomUUID();
      assistantId = randomUUID();
      this.messages.createTurn({
        botId,
        requestId: value.requestId,
        userId,
        assistantId,
        text: value.text,
        attachmentIds: files.map((file) => file.id),
      });
    }
    const generation: Generation = {
      controller: new AbortController(),
      content: '',
      assistantId,
      reason: 'interrupted',
      done: Promise.resolve(),
    };
    let resolveDone!: () => void;
    generation.done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.active.set(botId, generation);
    output.start();
    const emit = (event: ChatEvent) => output.emit(event);
    const removeDisconnect = output.onDisconnect(() => generation.controller.abort());
    emit({
      type: 'start',
      user: this.messages.message(userId),
      assistant: this.messages.message(assistantId),
    });
    let status: MessageStatus = 'complete',
      error: string | null = null,
      lastSaved = Date.now();
    try {
      const result = streamText({
        model: config.model,
        system: String(bot.instructions),
        messages: this.context(botId, config.vision),
        maxRetries: 0,
        abortSignal: generation.controller.signal,
        timeout: { totalMs: 180000, chunkMs: 45000 },
        maxOutputTokens: 4096,
        providerOptions: { openai: { store: false } },
        onError: () => {
          /* Errors are handled and redacted below, never logged by the SDK. */
        },
      });
      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          generation.content += chunk.text;
          emit({ type: 'delta', id: assistantId, text: chunk.text });
          if (Date.now() - lastSaved > 150) {
            this.messages.saveContent(assistantId, generation.content);
            lastSaved = Date.now();
          }
        } else if (chunk.type === 'error') throw chunk.error;
        else if (chunk.type === 'abort') {
          status = generation.controller.signal.aborted ? generation.reason : 'failed';
          error = status === 'failed' ? 'The provider timed out. Retry the response.' : null;
          break;
        }
      }
      if (generation.controller.signal.aborted) status = generation.reason;
      else if (!generation.content.trim()) {
        status = 'failed';
        error = 'The model returned no text. Check the model and try again.';
      }
    } catch (caught) {
      if (generation.controller.signal.aborted) status = generation.reason;
      else {
        status = 'failed';
        error = safeProviderError(caught);
      }
    } finally {
      if (status === 'interrupted')
        error = 'The connection ended before this response finished. You can retry.';
      try {
        this.messages.finish(assistantId, generation.content, status, error);
        emit({
          type: status === 'failed' ? 'error' : 'done',
          message: this.messages.message(assistantId),
        });
      } catch {
        // Preserve the already-saved user turn even if the disk fills during generation.
        const message = this.messages.message(assistantId);
        emit({
          type: 'error',
          message: {
            ...message,
            content: generation.content,
            status: 'failed',
            error: 'The response could not be saved. Free up local storage, then retry.',
          },
        });
      } finally {
        this.active.delete(botId);
        removeDisconnect();
        output.end();
        resolveDone();
      }
    }
  }
}
