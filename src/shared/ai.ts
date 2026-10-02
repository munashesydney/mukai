export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'compatible';
export interface ProviderSettings {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  supportsImages: boolean;
  isDefault: boolean;
  hasKey: boolean;
}
export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  supportsImages: boolean;
  isDefault: boolean;
  apiKey?: string;
  clearKey?: boolean;
}
export interface Bot {
  id: string;
  name: string;
  description: string;
  instructions: string;
  providerId: string | null;
  model: string | null;
  supportsImages: boolean | null;
  avatar: 'scout' | 'nova' | 'atlas';
  createdAt: string;
}
export type BotInput = Omit<Bot, 'id' | 'createdAt'>;
export interface Attachment {
  id: string;
  botId: string;
  messageId: string | null;
  name: string;
  mediaType: string;
  size: number;
  kind: 'image' | 'text';
  warning: string | null;
}
export type MessageStatus = 'complete' | 'streaming' | 'failed' | 'stopped' | 'interrupted';
export interface ChatMessage {
  id: string;
  requestId: string;
  botId: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  error: string | null;
  createdAt: string;
  attachments: Attachment[];
}
export type ChatEvent =
  | { type: 'start'; user: ChatMessage; assistant: ChatMessage }
  | { type: 'delta'; id: string; text: string }
  | { type: 'done' | 'error'; message: ChatMessage };
export interface ChatInput {
  requestId: string;
  text: string;
  attachmentIds: string[];
}
export interface ProviderTestResult {
  ok: boolean;
  message: string;
}
export const UPLOAD_LIMIT = 10 * 1024 * 1024;
export const ATTACHMENT_LIMIT = 4;
export const ACCEPTED_FILES =
  '.png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.csv,.json,.html,.xml,.ts,.js,.py,.css,.yaml,.yml,.log';
