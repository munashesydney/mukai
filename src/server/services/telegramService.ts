import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { TelegramAccessInput, TelegramStatus, TelegramUser } from '../../shared/telegram';
import type { ChatMessage } from '../../shared/ai';
import { responsePresentation } from '../../shared/responseParts';
import { ApiError, privateSecret } from '../config';
import {
  TelegramConnectionRepository,
  type TelegramConnection,
} from '../repositories/telegramConnectionRepository';
import { TelegramSessionRepository } from '../repositories/telegramSessionRepository';
import { TelegramJobRepository } from '../repositories/telegramJobRepository';
import { TelegramClient, TelegramApiError } from '../telegram/client';
import {
  updateSchema,
  type TelegramDelivery,
  type TelegramJob,
  type TelegramUpdate,
} from '../telegram/types';
import { parseCommand, splitTelegramText } from '../telegram/commands';
import type { WorkspaceService } from './workspaceService';
import type { BotService } from './botService';
import type { ConversationService } from './conversationService';
import type { ChatService } from './chatService';
import type { DiagnosticService } from './diagnosticService';
import type { TelegramActivity } from '../telegram/activity';
import type { ToolApproval } from '../../shared/approvals';
import type { TelegramSession } from '../telegram/types';
import { telegramMessage } from '../telegram/presentation';
import type { ConversationArtifactService } from './conversationArtifactService';
import { telegramFileLimit, telegramMediaLimit, telegramMediaReferences } from '../telegram/media';
import { downloadTelegramMedia } from '../telegram/remoteMedia';
import { fileMetadata } from './fileMetadata';

interface TelegramLifecycle {
  start(): void;
  stop(): Promise<void>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const publicUser = (user: { id: number; first_name: string; username?: string }): TelegramUser => ({
  id: user.id,
  firstName: user.first_name,
  ...(user.username ? { username: user.username } : {}),
});
function requestId(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class TelegramService {
  private key: Buffer;
  private lifecycle?: TelegramLifecycle;
  private activity?: TelegramActivity;
  private changing = false;
  private pairingCode?: { hash: string; code: string };
  private deliveryError: string | null = null;
  private runtimeStatus: TelegramStatus['runtime'] = {
    state: 'stopped',
    error: null,
    lastPollAt: null,
  };
  constructor(
    readonly connections: TelegramConnectionRepository,
    readonly sessions: TelegramSessionRepository,
    readonly jobs: TelegramJobRepository,
    private workspaces: WorkspaceService,
    private bots: BotService,
    readonly conversations: ConversationService,
    readonly chats: ChatService,
    private diagnostics: DiagnosticService,
    private artifacts: ConversationArtifactService,
    dir: string,
    private network: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {
    this.key = privateSecret(dir, 'credentials.key', 32);
  }
  attachRuntime(runtime: TelegramLifecycle) {
    this.lifecycle = runtime;
  }
  attachActivity(activity: TelegramActivity) {
    this.activity = activity;
  }
  workspaceAllowed(connectionId: string, chatId: number, workspaceId: string, botId?: string) {
    if (!this.targetAllowed(connectionId, chatId)) return false;
    try {
      return (
        !this.workspaces.require(workspaceId).deleting &&
        this.connections.access().some((row) => row.workspace_id === workspaceId) &&
        (!botId || this.bots.require(botId).workspaceId === workspaceId)
      );
    } catch {
      return false;
    }
  }
  approvalWorkspace(request: ToolApproval) {
    try {
      const bot = this.bots.require(request.botId);
      const conversation = this.conversations.require(request.conversationId);
      if (conversation.workspaceId !== bot.workspaceId) return;
      if (!conversation.botIds.includes(request.botId)) return;
      if (request.target && request.target.workspaceId !== bot.workspaceId) return;
      return bot.workspaceId;
    } catch {
      return;
    }
  }
  sessionAllowed(session: TelegramSession) {
    if (!session.notificationId)
      return this.targetAllowed(
        session.connectionId,
        session.chatId,
        session.workspaceId,
        session.botId,
      );
    if (
      !this.workspaceAllowed(
        session.connectionId,
        session.chatId,
        session.workspaceId,
        session.botId,
      )
    )
      return false;
    return !!this.jobs.database.get(
      `SELECT 1 FROM bot_notifications n JOIN conversations c ON c.id=?
       WHERE n.id=? AND n.workspace_id=? AND n.bot_id=? AND c.workspace_id=n.workspace_id AND c.owner_bot_id=n.bot_id AND c.kind='private'`,
      session.conversationId,
      session.notificationId,
      session.workspaceId,
      session.botId,
    );
  }
  messageText(text: string, workspaceId?: string, botId?: string) {
    const name = workspaceId
      ? this.workspaces.list().find((workspace) => workspace.id === workspaceId)?.name
      : undefined;
    let botName: string | undefined;
    if (botId) {
      try {
        const bot = this.bots.require(botId);
        if (bot.workspaceId === workspaceId) botName = bot.name;
      } catch {
        /* A deleted bot has no public label. */
      }
    }
    return telegramMessage(this.diagnostics.redactSecrets(text), name, botName);
  }
  connection() {
    return this.connections.get();
  }
  workspaceConnected(workspaceId: string) {
    const connection = this.connection();
    return Boolean(
      connection && this.workspaceAllowed(connection.id, connection.ownerChatId ?? 0, workspaceId),
    );
  }
  setRuntime(state: TelegramStatus['runtime']['state'], error: string | null = null) {
    if (state === 'stopped') this.deliveryError = null;
    this.runtimeStatus = {
      ...this.runtimeStatus,
      state,
      error,
      ...(state === 'polling' ? { lastPollAt: new Date(this.now()).toISOString() } : {}),
    };
  }
  reportDeliveryError(message: string) {
    this.deliveryError = message;
  }
  private encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  client(connection = this.connection()) {
    if (!connection) throw new ApiError(409, 'Connect a Telegram bot first.');
    const data = Buffer.from(connection.encryptedToken, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    const token = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
    this.diagnostics.registerSecret(token);
    return new TelegramClient(token, this.network);
  }
  status(): TelegramStatus {
    const connection = this.connection(),
      access = this.connections.access();
    const pairing =
      connection?.pairingExpiresAt && connection.pairingExpiresAt > this.now()
        ? {
            expiresAt: new Date(connection.pairingExpiresAt).toISOString(),
            candidate: connection.candidate,
            ...(connection.pairingHash && this.pairingCode?.hash === connection.pairingHash
              ? {
                  code: this.pairingCode.code,
                  url: `https://t.me/${connection.bot.username}?start=${this.pairingCode.code}`,
                }
              : {}),
          }
        : null;
    return {
      configured: !!connection,
      enabled: connection?.enabled ?? false,
      bot: connection?.bot ?? null,
      owner: connection?.owner ?? null,
      pairing,
      workspaces: this.workspaces
        .list()
        .filter((workspace) => !workspace.deleting)
        .map((workspace) => {
          const allowed = access.find((row) => row.workspace_id === workspace.id);
          return {
            id: workspace.id,
            name: workspace.name,
            enabled: !!allowed,
            botId: (allowed?.bot_id as string | null) ?? null,
            bots: this.bots
              .list(workspace.id)
              .map((bot) => ({ id: bot.id, name: bot.name, isMain: bot.isMain })),
          };
        }),
      runtime: {
        ...this.runtimeStatus,
        ...(this.deliveryError ? { state: 'error', error: this.deliveryError } : {}),
      },
      queue: this.jobs.counts(),
    };
  }
  private async change<T>(operation: () => Promise<T>) {
    if (this.changing)
      throw new ApiError(409, 'Another Telegram setting is being saved. Try again.');
    this.changing = true;
    try {
      return await operation();
    } finally {
      this.changing = false;
    }
  }
  connect(token: string) {
    return this.change(async () => {
      this.diagnostics.registerSecret(token);
      const client = new TelegramClient(token, this.network);
      let identity;
      try {
        identity = await client.identity();
        const webhook = await client.call<{ url: string }>('getWebhookInfo', {});
        if (webhook.url)
          throw new ApiError(
            409,
            'This bot has a webhook configured. Remove it or use a dedicated bot for Mukai.',
          );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          400,
          error instanceof TelegramApiError
            ? error.message
            : 'Telegram returned an invalid bot identity. Check the BotFather token.',
        );
      }
      await this.lifecycle?.stop();
      this.connections.replace(randomUUID(), this.encrypt(token), {
        id: identity.id,
        username: identity.username,
        firstName: identity.first_name,
      });
      this.pairingCode = undefined;
      this.lifecycle?.start();
      return this.status();
    });
  }
  pairing() {
    const connection = this.connection();
    if (!connection || !connection.enabled)
      throw new ApiError(409, 'Connect and enable your Telegram bot first.');
    if (connection.owner)
      throw new ApiError(409, 'Unpair the current account before pairing another.');
    if (this.changing) throw new ApiError(409, 'Wait for the connection change to finish.');
    const code = randomBytes(24).toString('base64url');
    this.pairingCode = { hash: hash(code), code };
    this.diagnostics.registerSecret(code);
    this.connections.pair(this.pairingCode.hash, this.now() + 5 * 60000);
    return this.status();
  }
  approve(userId: number) {
    if (this.changing) throw new ApiError(409, 'Wait for the connection change to finish.');
    const connection = this.connection();
    if (
      !connection?.enabled ||
      connection.owner ||
      !connection.candidate ||
      connection.candidate.id !== userId ||
      !connection.pairingExpiresAt ||
      connection.pairingExpiresAt <= this.now()
    )
      throw new ApiError(
        409,
        'This pairing request changed or expired. Generate a new link and try again.',
      );
    this.connections.approve(connection.candidate, Math.floor(this.now() / 1000));
    this.pairingCode = undefined;
    this.jobs.queue({
      connectionId: connection.id,
      chatId: userId,
      text: 'Your Telegram account is now paired with Mukai. Enable your workspaces in Mukai, then send /workspaces to choose one.',
    });
    return this.status();
  }
  setAccess(input: TelegramAccessInput) {
    return this.change(async () => {
      if (!this.connection()) throw new ApiError(409, 'Connect a Telegram bot first.');
      if (
        new Set(input.workspaces.map((value) => value.workspaceId)).size !== input.workspaces.length
      )
        throw new ApiError(400, 'Choose each workspace once.');
      for (const value of input.workspaces) {
        this.workspaces.require(value.workspaceId);
        const available = this.bots.list(value.workspaceId);
        if (!available.some((bot) => (value.botId ? bot.id === value.botId : bot.isMain)))
          throw new ApiError(400, 'Choose an available bot from the selected workspace.');
      }
      const previous = this.sessions.all();
      this.connections.setAccess(input.workspaces);
      for (const session of previous) {
        if (!this.sessionAllowed(session)) {
          this.chats.stopConversation(session.conversationId);
          this.jobs.cancelConversation(session.conversationId);
        }
      }
      return this.status();
    });
  }
  setEnabled(enabled: boolean) {
    return this.change(async () => {
      if (!this.connection()) throw new ApiError(409, 'Connect a Telegram bot first.');
      await this.lifecycle?.stop();
      this.connections.enabled(enabled);
      if (!enabled) this.jobs.clearInbox();
      if (enabled) this.lifecycle?.start();
      return this.status();
    });
  }
  disconnect(ownerOnly = false) {
    return this.change(async () => {
      await this.lifecycle?.stop();
      if (ownerOnly) this.connections.revoke();
      else this.connections.remove();
      this.pairingCode = undefined;
      if (ownerOnly) this.lifecycle?.start();
      return this.status();
    });
  }
  private authorized(connection: TelegramConnection, update: TelegramUpdate) {
    const message = update.message ?? update.callback_query?.message;
    const from = update.callback_query?.from ?? update.message?.from;
    return !!(
      connection.enabled &&
      connection.owner &&
      message &&
      from &&
      !from.is_bot &&
      message.chat.type === 'private' &&
      message.chat.id === from.id &&
      from.id === connection.owner.id &&
      message.chat.id === connection.ownerChatId &&
      (!update.message || message.date >= connection.authorizedAt)
    );
  }
  accept(connectionId: string, updates: unknown[]) {
    const connection = this.connection();
    if (!connection?.enabled || connection.id !== connectionId) return;
    const accepted: { id: number; payload?: TelegramUpdate }[] = [];
    for (const raw of updates) {
      const id = (raw as { update_id?: unknown })?.update_id;
      if (
        typeof id !== 'number' ||
        !Number.isSafeInteger(id) ||
        id < 0 ||
        id < connection.nextOffset
      )
        continue;
      const parsed = updateSchema.safeParse(raw);
      if (!parsed.success) {
        accepted.push({ id });
        continue;
      }
      const update = parsed.data,
        message = update.message;
      // A pairing secret is checked here and never enters the durable message inbox.
      if (
        !connection.owner &&
        !connection.candidate &&
        connection.pairingHash &&
        connection.pairingExpiresAt &&
        connection.pairingExpiresAt > this.now() &&
        message?.from &&
        !message.from.is_bot &&
        message.chat.type === 'private' &&
        message.chat.id === message.from.id
      ) {
        const code = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{32})$/.exec(
          message.text ?? '',
        )?.[1];
        if (code && timingSafeEqual(Buffer.from(hash(code)), Buffer.from(connection.pairingHash))) {
          this.connections.claim(publicUser(message.from));
          connection.candidate = publicUser(message.from);
          this.pairingCode = undefined;
        }
      }
      accepted.push({ id, ...(this.authorized(connection, update) ? { payload: update } : {}) });
    }
    this.jobs.accept(
      connectionId,
      accepted.sort((a, b) => a.id - b.id),
    );
  }
  private resolvedBot(workspaceId: string) {
    const access = this.connections.access().find((row) => row.workspace_id === workspaceId);
    if (!access) return;
    try {
      const workspace = this.workspaces.require(workspaceId);
      if (workspace.deleting) return;
      return this.bots
        .list(workspaceId)
        .find((bot) => (access.bot_id ? bot.id === access.bot_id : bot.isMain));
    } catch {
      return;
    }
  }
  targetAllowed(connectionId: string, chatId: number, workspaceId?: string, botId?: string) {
    const connection = this.connection();
    if (
      !connection?.enabled ||
      connection.id !== connectionId ||
      connection.ownerChatId !== chatId ||
      !connection.owner
    )
      return false;
    return !workspaceId || (!!botId && this.resolvedBot(workspaceId)?.id === botId);
  }
  jobAllowed(job: TelegramJob) {
    return this.jobs.runnable(job.id) && this.sessionAllowed(job);
  }
  private callback(connection: TelegramConnection, workspaceId: string) {
    const bot = this.resolvedBot(workspaceId);
    const signature = createHmac('sha256', this.key)
      .update(
        `${connection.id}:${connection.authorizationId}:${connection.owner?.id}:${workspaceId}:${bot?.id}`,
      )
      .digest('base64url')
      .slice(0, 12);
    return `w:${workspaceId}:${signature}`;
  }
  dispatch(connectionId: string, update: TelegramUpdate) {
    const connection = this.connection();
    if (!connection || connection.id !== connectionId || !this.authorized(connection, update))
      return;
    const message = update.message ?? update.callback_query?.message;
    if (!message) return;
    const chatId = message.chat.id,
      id = requestId(`${connectionId}:${update.update_id}`);
    const selected = this.sessions.current(connectionId, chatId);
    const context = selected && this.sessionAllowed(selected) ? selected : undefined;
    const reply = (text: string, workspaceId = context?.workspaceId, botId = context?.botId) =>
      this.jobs.queue(
        {
          connectionId,
          chatId,
          text,
          workspaceId,
          botId,
          workspaceEvent: !!context?.notificationId,
        },
        id,
      );
    if (this.activity?.handle(connection, update, id)) return;
    if (update.callback_query) {
      const data = update.callback_query.data ?? '',
        match = /^w:(.{1,40}):([A-Za-z0-9_-]{12})$/.exec(data);
      const bot = match && this.resolvedBot(match[1]);
      if (!match || !bot || data !== this.callback(connection, match[1])) {
        reply(
          'This workspace selection expired or access changed. Send /workspaces to choose again.',
        );
        return;
      }
      const session = this.sessions.select(connectionId, chatId, match[1], bot.id);
      reply(
        `You’re chatting with ${bot.name} in ${this.workspaces.require(session.workspaceId).name}. Send a message, or use /new for a fresh conversation.`,
        session.workspaceId,
        session.botId,
      );
      return;
    }
    const text = message.text?.trim() ?? '';
    const command = parseCommand(text, connection.bot.username);
    if (command === 'workspaces') {
      const choices = this.status().workspaces.filter(
        (workspace) => workspace.enabled && this.resolvedBot(workspace.id),
      );
      this.jobs.queue(
        {
          connectionId,
          chatId,
          text: choices.length
            ? 'Choose a workspace to start chatting.'
            : 'No workspaces are enabled yet. Open Telegram in Mukai to choose which workspaces this account can access.',
          markup: choices.length
            ? {
                inline_keyboard: choices.map((workspace) => [
                  {
                    text: workspace.name.slice(0, 64),
                    callback_data: this.callback(connection, workspace.id),
                  },
                ]),
              }
            : undefined,
        },
        id,
      );
      return;
    }
    const session = this.sessions.current(connectionId, chatId);
    if (command === 'stop' || command === 'new') {
      if (!session) {
        reply('Send /workspaces and choose a workspace first.');
        return;
      }
      this.jobs.cancelConversation(session.conversationId);
      this.chats.stopConversation(session.conversationId);
      if (command === 'new') {
        if (!this.sessionAllowed(session)) {
          reply('Workspace access changed. Send /workspaces to choose again.');
          return;
        }
        this.sessions.select(
          connectionId,
          chatId,
          session.workspaceId,
          session.botId,
          true,
          session.notificationId,
        );
      }
      reply(
        command === 'new'
          ? 'A fresh conversation is ready. What would you like to work on?'
          : 'Stopped the current response and cleared queued messages in this conversation.',
      );
      return;
    }
    if (command) {
      reply(
        'Send /workspaces to choose a workspace, then write a message. Use /new for a fresh conversation or /stop to stop a response. Approvals, questions, and bot updates from enabled workspaces arrive here. Use their buttons or reply to a question. /approvals shows waiting requests; /updates shows unread updates.',
      );
      return;
    }
    if (!text) {
      reply('Telegram v1 supports text messages. Please type what you’d like Mukai to work on.');
      return;
    }
    if (!session || !this.sessionAllowed(session)) {
      reply('Send /workspaces and choose an enabled workspace first.');
      return;
    }
    if (this.jobs.jobs('queued').length >= 20) {
      reply(
        'Your message queue is full. Wait for a reply or use /stop to clear this conversation.',
      );
      return;
    }
    this.jobs.enqueue(session, text, message.message_id, id);
  }
  finish(job: TelegramJob, message?: ChatMessage) {
    if (!this.jobAllowed(job)) return;
    const answer = message ? responsePresentation(message).answer : '';
    let text =
      message?.status === 'complete'
        ? answer ||
          'The response completed without a text answer. Open this conversation in Mukai for details.'
        : message?.status === 'stopped'
          ? 'This response was stopped. Open Mukai to review any completed work.'
          : 'This response was interrupted or failed. Open Mukai to review the saved progress before retrying.';
    const media =
      message?.status === 'complete'
        ? telegramMediaReferences(this.diagnostics.redactSecrets(answer))
        : [];
    if (media.length > telegramMediaLimit)
      text += `\n\nOnly the first ${telegramMediaLimit} referenced files will be sent here. Open Mukai for the remaining files.`;
    this.jobs.complete(
      job,
      splitTelegramText(text),
      message?.status === 'complete' ? 'done' : 'interrupted',
      media.slice(0, telegramMediaLimit),
    );
  }
  async loadMedia(value: TelegramDelivery, signal: AbortSignal) {
    if (!value.media || !value.workspaceId || !value.botId || !this.deliveryAllowed(value))
      throw new Error('Telegram media access changed.');
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    const source = /^https?:\/\//i.test(value.media.href)
      ? await downloadTelegramMedia(value.media.href, readSignal)
      : await this.artifacts.reference(
          value.workspaceId,
          value.media.href,
          false,
          readSignal,
          telegramFileLimit,
        );
    readSignal.throwIfAborted();
    if (!source.bytes.length || source.bytes.length > telegramFileLimit)
      throw new Error('The media file is empty or exceeds the Telegram file limit.');
    return {
      ...source,
      ...fileMetadata(source.bytes.subarray(0, 4096), source.name, source.bytes.length),
    };
  }
  recover(job: TelegramJob) {
    const message = this.conversations.latestBotReply(job.conversationId, job.botId, job.id);
    if (
      message?.status === 'streaming' &&
      this.chats.runningRequest(job.conversationId, job.id, job.botId)
    )
      return;
    if (this.chats.pendingRequest(job.conversationId) === job.id) return;
    // Never replay an interrupted provider/tool execution after a crash.
    this.finish(job, message ?? undefined);
  }
  deliveryAllowed(value: TelegramDelivery) {
    if (
      value.media &&
      (!value.workspaceId ||
        !value.botId ||
        value.editMessageId ||
        !this.jobs.deliveryActive(value.id))
    )
      return false;
    const allowed =
      value.workspaceEvent && value.workspaceId
        ? this.workspaceAllowed(value.connectionId, value.chatId, value.workspaceId, value.botId)
        : this.targetAllowed(value.connectionId, value.chatId, value.workspaceId, value.botId);
    return allowed && (this.activity?.validDelivery(value) ?? true);
  }
  stopWorkspace(workspaceId: string) {
    for (const session of this.sessions
      .all()
      .filter((value) => value.workspaceId === workspaceId)) {
      this.jobs.cancelConversation(session.conversationId);
      this.chats.stopConversation(session.conversationId);
    }
    this.sessions.forgetWorkspace(workspaceId);
  }
}
