import type { Attachment, Bot, ChatMessage, ProviderSettings } from '../../shared/ai';

// Internal records never cross the HTTP boundary without an explicit public projection.
export type BotRecord = Bot;
export interface ProviderRecord extends Omit<ProviderSettings, 'hasKey'> {
  encryptedKey: string | null;
}
export interface AttachmentRecord extends Attachment {
  conversationId: string | null;
  storageName: string;
  extractedText: string | null;
}
export interface MessageRecord extends Omit<ChatMessage, 'attachments'> {
  sequence: number;
}

export function publicProvider(record: ProviderRecord): ProviderSettings {
  const { encryptedKey, ...settings } = record;
  return { ...settings, hasKey: Boolean(encryptedKey) };
}
export function publicAttachment(record: AttachmentRecord): Attachment {
  const { id, botId, messageId, name, mediaType, size, kind, warning } = record;
  return { id, botId, messageId, name, mediaType, size, kind, warning };
}
export function publicMessage(record: MessageRecord, attachments: AttachmentRecord[]): ChatMessage {
  const {
    id,
    requestId,
    botId,
    role,
    content,
    status,
    error,
    createdAt,
    reasoning,
    activity,
    parts,
    startedAt,
    finishedAt,
    conversationId,
    authorName,
    saved,
    contextUsage,
  } = record;
  return {
    id,
    requestId,
    botId,
    role,
    content,
    status,
    error,
    createdAt,
    reasoning,
    activity,
    parts,
    startedAt,
    finishedAt,
    conversationId,
    authorName,
    saved,
    contextUsage,
    attachments: attachments.map(publicAttachment),
  };
}
