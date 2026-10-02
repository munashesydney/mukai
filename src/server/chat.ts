import type { ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamText, type ModelMessage, type UserContent } from 'ai';
import { z } from 'zod';
import type { ChatEvent, MessageStatus } from '../shared/ai';
import { Store, type Row } from './database';
import { Providers, safeProviderError } from './providers';
import { Attachments } from './attachments';
import { ApiError } from './config';

const inputSchema = z.object({
  requestId: z.string().uuid(),
  text: z.string().trim().max(16000),
  attachmentIds: z.array(z.string().uuid()).max(4),
});
interface Generation {
  controller: AbortController;
  content: string;
  assistantId: string;
  reason: 'stopped' | 'interrupted';
  done: Promise<void>;
}
export class Chats {
  private active = new Map<string, Generation>();
  constructor(
    private store: Store,
    private providers: Providers,
    private attachments: Attachments,
  ) {}
  busy(id: string) {
    return this.active.has(id);
  }
  history(id: string) {
    if (!this.busy(id))
      this.store.run(
        "UPDATE messages SET status = 'interrupted', error = 'This response did not finish saving. You can retry.' WHERE bot_id = ? AND status = 'streaming'",
        id,
      );
    return this.store.messages(id);
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
    const rows = this.store
      .all(
        "SELECT * FROM messages WHERE bot_id = ? AND status != 'streaming' AND (role = 'user' OR content != '') ORDER BY sequence DESC LIMIT 10",
        botId,
      )
      .reverse();
    return rows.map((row) => {
      if (row.role === 'assistant')
        return { role: 'assistant' as const, content: String(row.content) };
      const content: UserContent = [
        { type: 'text', text: String(row.content) || 'Please review the attached files.' },
      ];
      for (const file of this.store.all('SELECT * FROM attachments WHERE message_id = ?', row.id)) {
        if (file.kind === 'image' && vision)
          content.push({
            type: 'file',
            data: readFileSync(join(this.store.uploads, String(file.storage_name))),
            mediaType: String(file.media_type),
          });
        else
          content.push({
            type: 'text',
            text:
              file.kind === 'text'
                ? `Attached document: ${String(file.name)}\n<document>\n${String(file.extracted_text)}\n</document>`
                : `[An image named ${String(file.name)} was attached previously; this text-only model cannot view it.]`,
          });
      }
      return { role: 'user' as const, content };
    });
  }
  async respond(bot: Row, input: unknown, response: ServerResponse) {
    const value = inputSchema.parse(input);
    const botId = String(bot.id);
    if (this.busy(botId))
      throw new ApiError(409, 'This bot is already responding. Stop it or wait for it to finish.');
    const config = this.providers.resolve(bot);
    const existingUser = this.store.get(
      "SELECT * FROM messages WHERE bot_id = ? AND request_id = ? AND role = 'user'",
      botId,
      value.requestId,
    );
    let userId: string, assistantId: string;
    if (existingUser) {
      userId = String(existingUser.id);
      const assistant = this.store.get(
        "SELECT * FROM messages WHERE bot_id = ? AND request_id = ? AND role = 'assistant'",
        botId,
        value.requestId,
      )!;
      assistantId = String(assistant.id);
      if (assistant.status === 'complete') {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        response.end(
          JSON.stringify({
            type: 'start',
            user: this.store.message(userId),
            assistant: this.store.message(assistantId),
          }) +
            '\n' +
            JSON.stringify({ type: 'done', message: this.store.message(assistantId) }) +
            '\n',
        );
        return;
      }
      const latest = this.store.get(
        "SELECT id FROM messages WHERE bot_id = ? AND role = 'user' ORDER BY sequence DESC LIMIT 1",
        botId,
      );
      if (latest?.id !== userId)
        throw new ApiError(
          409,
          'Only the most recent response can be retried. Send a new message instead.',
        );
      const previousFiles = this.store.all(
        'SELECT * FROM attachments WHERE message_id = ?',
        userId,
      );
      if (!config.vision && previousFiles.some((file) => file.kind === 'image'))
        throw new ApiError(400, 'Choose a vision model before retrying this image message.');
      this.store.run(
        "UPDATE messages SET content = '', status = 'streaming', error = NULL WHERE id = ?",
        assistantId,
      );
    } else {
      if (!value.text && !value.attachmentIds.length)
        throw new ApiError(400, 'Write a message or attach a file.');
      const files = this.attachments.select(value.attachmentIds, botId, config.vision);
      userId = this.store.id();
      assistantId = this.store.id();
      this.store.transaction(() => {
        const now = new Date().toISOString();
        this.store.run(
          'INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)',
          userId,
          botId,
          value.requestId,
          'user',
          value.text,
          'complete',
          now,
        );
        this.store.run(
          'INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)',
          assistantId,
          botId,
          value.requestId,
          'assistant',
          '',
          'streaming',
          now,
        );
        files.forEach((file) =>
          this.store.run('UPDATE attachments SET message_id = ? WHERE id = ?', userId, file.id),
        );
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
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const emit = (event: ChatEvent) => {
      if (!response.destroyed) response.write(JSON.stringify(event) + '\n');
    };
    const onDisconnect = () => {
      if (!response.writableEnded) generation.controller.abort();
    };
    response.on('close', onDisconnect);
    emit({
      type: 'start',
      user: this.store.message(userId),
      assistant: this.store.message(assistantId),
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
            this.store.run(
              'UPDATE messages SET content = ? WHERE id = ?',
              generation.content,
              assistantId,
            );
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
        this.store.run(
          'UPDATE messages SET content = ?, status = ?, error = ? WHERE id = ?',
          generation.content,
          status,
          error,
          assistantId,
        );
        emit({
          type: status === 'failed' ? 'error' : 'done',
          message: this.store.message(assistantId),
        });
      } catch {
        // Preserve the already-saved user turn even if the disk fills during generation.
        const message = this.store.message(assistantId);
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
        response.off('close', onDisconnect);
        response.end();
        resolveDone();
      }
    }
  }
}
