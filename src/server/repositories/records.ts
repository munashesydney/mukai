import type { Row } from '../db/database';
import type {
  AttachmentRecord,
  BotRecord,
  MessageRecord,
  ProviderRecord,
} from '../models/entities';

export function botRecord(row: Row): BotRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    instructions: String(row.instructions),
    providerId: row.provider_id as string | null,
    model: row.model as string | null,
    supportsImages: row.supports_images === null ? null : Boolean(row.supports_images),
    avatar: row.avatar as BotRecord['avatar'],
    createdAt: String(row.created_at),
  };
}
export function providerRecord(row: Row): ProviderRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as ProviderRecord['kind'],
    baseUrl: String(row.base_url),
    defaultModel: String(row.default_model),
    supportsImages: Boolean(row.supports_images),
    isDefault: Boolean(row.is_default),
    encryptedKey: row.encrypted_key as string | null,
  };
}
export function attachmentRecord(row: Row): AttachmentRecord {
  return {
    id: String(row.id),
    botId: String(row.bot_id),
    messageId: row.message_id as string | null,
    name: String(row.name),
    mediaType: String(row.media_type),
    size: Number(row.size),
    kind: row.kind as AttachmentRecord['kind'],
    warning: row.warning as string | null,
    storageName: String(row.storage_name),
    extractedText: row.extracted_text as string | null,
  };
}
export function messageRecord(row: Row): MessageRecord {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    botId: String(row.bot_id),
    role: row.role as MessageRecord['role'],
    content: String(row.content),
    status: row.status as MessageRecord['status'],
    error: row.error as string | null,
    createdAt: String(row.created_at),
    sequence: Number(row.sequence),
  };
}
