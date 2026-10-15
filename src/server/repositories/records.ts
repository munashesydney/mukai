import type { Row } from '../db/database';
import { resolveBotAvatar } from '../../shared/mascots';
import type {
  AttachmentRecord,
  BotRecord,
  MessageRecord,
  ProviderRecord,
} from '../models/entities';

export function botRecord(row: Row): BotRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    role: String(row.role),
    instructions: String(row.instructions),
    providerId: row.provider_id as string | null,
    model: row.model as string | null,
    supportsImages: row.supports_images === null ? null : Boolean(row.supports_images),
    avatar: resolveBotAvatar(row.avatar),
    createdAt: String(row.created_at),
    isMain: Boolean(row.is_main),
    createdBy: row.created_by as string | null,
    contextWindowTokens:
      row.context_window_tokens == null ? null : Number(row.context_window_tokens),
    maxOutputTokens: row.max_output_tokens == null ? null : Number(row.max_output_tokens),
  };
}
export function providerRecord(row: Row): ProviderRecord {
  return {
    models: JSON.parse(String(row.models_json || '[]')),
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as ProviderRecord['kind'],
    baseUrl: String(row.base_url),
    defaultModel: String(row.default_model),
    supportsImages: Boolean(row.supports_images),
    isDefault: Boolean(row.is_default),
    encryptedKey: row.encrypted_key as string | null,
    contextWindowTokens:
      row.context_window_tokens == null ? null : Number(row.context_window_tokens),
    maxOutputTokens: Number(row.max_output_tokens || 8192),
  };
}
export function attachmentRecord(row: Row): AttachmentRecord {
  return {
    conversationId: row.conversation_id as string | null,
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
    botId: row.bot_id === null ? '' : String(row.bot_id),
    conversationId: String(row.conversation_id || ''),
    authorName: String(row.author_name || ''),
    saved: Boolean(row.saved),
    role: row.role as MessageRecord['role'],
    content: String(row.content),
    ...(row.source === 'telegram' ? { source: 'telegram' as const } : {}),
    status: row.status as MessageRecord['status'],
    error: row.error as string | null,
    createdAt: String(row.created_at),
    sequence: Number(row.sequence),
    reasoning: String(row.reasoning || ''),
    activity: JSON.parse(String(row.activity_json || '[]')) as MessageRecord['activity'],
    parts: JSON.parse(String(row.parts_json || '[]')) as MessageRecord['parts'],
    startedAt: row.started_at as string | null,
    finishedAt: row.finished_at as string | null,
    contextUsage: row.context_usage_json ? JSON.parse(String(row.context_usage_json)) : undefined,
  };
}
