import { z } from 'zod';

const telegramId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const userSchema = z.object({
  id: telegramId,
  is_bot: z.boolean().optional(),
  first_name: z.string().max(256),
  username: z.string().max(64).optional(),
});
const messageSchema = z.object({
  message_id: telegramId,
  date: z.number().int().nonnegative(),
  chat: z.object({ id: z.number().int().safe(), type: z.string().max(32) }),
  from: userSchema.optional(),
  text: z.string().max(16000).optional(),
  reply_to_message: z.object({ message_id: telegramId }).optional(),
});
export const updateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string().max(256),
      from: userSchema,
      message: messageSchema.optional(),
      data: z.string().max(64).optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof updateSchema>;
export type TelegramUserRecord = z.infer<typeof userSchema>;
export type TelegramMarkup =
  | { inline_keyboard: { text: string; callback_data: string }[][] }
  | { force_reply: true; input_field_placeholder?: string; selective?: boolean };
export interface TelegramSession {
  id: string;
  connectionId: string;
  chatId: number;
  workspaceId: string;
  botId: string;
  conversationId: string;
  notificationId?: string;
}
export interface TelegramJob extends TelegramSession {
  sequence: number;
  sessionId: string;
  sourceMessageId: number;
  text: string;
  state: 'queued' | 'running' | 'done' | 'cancelled' | 'interrupted';
}
export interface TelegramMediaReference {
  href: string;
  label: string;
}
export interface TelegramMediaFile {
  name: string;
  bytes: Buffer;
  mediaType: string;
}
export interface TelegramDelivery {
  id: string;
  connectionId: string;
  chatId: number;
  text: string;
  markup?: TelegramMarkup;
  replyTo?: number;
  replyAction?: 'deny_reason';
  workspaceId?: string;
  botId?: string;
  attempts: number;
  workspaceEvent?: boolean;
  eventId?: string;
  editMessageId?: number;
  priority?: number;
  media?: TelegramMediaReference;
}
