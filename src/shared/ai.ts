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
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  providerId: string | null;
  model: string | null;
  supportsImages: boolean | null;
  avatar: 'scout' | 'nova' | 'atlas';
  createdAt: string;
}
export type BotInput = Omit<Bot, 'id' | 'createdAt' | 'workspaceId'>;
export interface Workspace {
  id: string;
  name: string;
  folder: string | null;
  createdAt: string;
}
export interface WorkspaceInput {
  name: string;
  folder: string;
}
export interface ChatActivity {
  id: string;
  tool: string;
  action: string;
  path: string;
  status: 'running' | 'complete' | 'failed' | 'interrupted';
  summary: string;
}
export interface FileArtifact {
  id: string;
  botId: string;
  messageId: string;
  name: string;
  path: string;
  createdAt: string;
}
export interface ToolInfo {
  id: string;
  name: string;
  description: string;
  actions: string[];
  scope: 'all-bots' | 'selected-bots';
  available: boolean;
  counts: Record<string, number>;
}
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
export type ResponsePart =
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'reasoning'; text: string; state?: 'streaming' | 'complete' }
  | { id: string; type: 'tool'; activityId: string };
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
  reasoning?: string;
  activity?: ChatActivity[];
  parts?: ResponsePart[];
  startedAt?: string | null;
  finishedAt?: string | null;
}
export type ChatEvent =
  | { type: 'start'; user: ChatMessage; assistant: ChatMessage }
  | { type: 'delta'; id: string; text: string; partId?: string }
  | { type: 'reasoning'; id: string; text: string; partId?: string }
  | { type: 'part'; id: string; part: ResponsePart }
  | { type: 'activity'; id: string; activity: ChatActivity }
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
