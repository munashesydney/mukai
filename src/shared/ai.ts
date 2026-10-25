import type { FileChangeSummary } from './fileChanges';
import type { VmResources } from './computer';
import type { BotAvatar } from './mascots';

export type ProviderKind = 'openai' | 'chatgpt' | 'anthropic' | 'google' | 'compatible';
export interface ChatGPTAccount {
  label: string;
  clientId: string;
  connected: boolean;
  planEnabled: boolean;
}
export interface ProviderModel {
  supportsAudio?: boolean | null;
  supportsVideo?: boolean | null;
  id: string;
  name: string;
  category: 'GPT' | 'Codex' | 'Reasoning' | 'Other';
  contextWindowTokens: number | null;
  supportsImages: boolean | null;
}
export interface SavedProviderModel {
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  id: string;
  name: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number;
  supportsImages: boolean;
}
export interface ChatGPTSignIn {
  id: string;
  url?: string;
  status: 'pending' | 'complete' | 'failed' | 'cancelled';
  providerId?: string;
  message?: string;
}
export interface ProviderSettings {
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  models?: SavedProviderModel[];
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  supportsImages: boolean;
  isDefault: boolean;
  hasKey: boolean;
  account?: ChatGPTAccount;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number;
}
export interface ProviderInput {
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  models?: SavedProviderModel[];
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  supportsImages: boolean;
  isDefault: boolean;
  apiKey?: string;
  clearKey?: boolean;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number;
}
export interface ProviderModelsInput {
  models: SavedProviderModel[];
  defaultModel: string;
}
export interface Bot {
  id: string;
  workspaceId: string;
  name: string;
  role: string;
  instructions: string;
  providerId: string | null;
  model: string | null;
  supportsImages: boolean | null;
  avatar: BotAvatar;
  createdAt: string;
  isMain: boolean;
  createdBy: string | null;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
}
export type BotInput = Omit<Bot, 'id' | 'createdAt' | 'workspaceId' | 'isMain' | 'createdBy'>;
export type BotModelInput = Pick<
  Bot,
  'providerId' | 'model' | 'supportsImages' | 'contextWindowTokens'
>;
export const mainBotRole = 'Main Bot/Orchestrator';
export interface Workspace {
  id: string;
  name: string;
  folder: string | null;
  createdAt: string;
  computer?: 'local' | 'qemu';
  computerResources?: VmResources;
  deleting?: boolean;
}
export interface WorkspaceDeletionResult {
  deleted: true;
  botIds: string[];
  conversationIds: string[];
}
export interface WorkspaceInput {
  name: string;
  folder: string;
  computer?: 'local' | 'qemu';
}
export interface ChatActivity {
  id: string;
  tool: string;
  action: string;
  path: string;
  status: 'running' | 'complete' | 'failed' | 'interrupted';
  summary: string;
  delegation?: { botId: string; botName: string; conversationId: string; requestId: string };
  createdBotId?: string;
  attachmentId?: string;
  artifactId?: string;
  processSessionId?: string;
  serverUrls?: string[];
}
export interface FileArtifact {
  kind?: 'file' | 'image';
  mediaType?: string;
  size?: number;
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
  kind: 'image' | 'text' | 'audio' | 'video';
  warning: string | null;
}
export type MessageStatus = 'complete' | 'streaming' | 'failed' | 'stopped' | 'interrupted';
export type ResponsePart =
  | { id: string; type: 'steering'; text: string; createdAt?: string }
  | { id: string; type: 'text'; text: string; continuationOf?: string; final?: boolean }
  | { id: string; type: 'reasoning'; text: string; state?: 'streaming' | 'complete' }
  | {
      id: string;
      type: 'compaction';
      state: 'compacting' | 'complete' | 'failed' | 'interrupted';
      startedAt: string;
      finishedAt?: string;
      tokensBefore: number;
      tokensAfter?: number;
    }
  | { id: string; type: 'tool'; activityId: string };
export interface ChatMessage {
  id: string;
  requestId: string;
  botId: string;
  role: 'user' | 'assistant';
  source?: 'telegram';
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
  changes?: FileChangeSummary[];
  conversationId?: string;
  authorName?: string;
  saved?: boolean;
  contextUsage?: ContextUsage;
}
export interface ContextUsage {
  usedTokens: number;
  contextWindow: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimated: boolean;
  runTokens: number;
  runEstimated?: boolean;
  compactions: number;
  phase: 'ready' | 'compacting' | 'failed';
}
export type ChatEvent =
  | { type: 'followups'; followups: ChatFollowup[] }
  | { type: 'approval'; id: string }
  | { type: 'start'; user: ChatMessage; assistant: ChatMessage }
  | { type: 'delta'; id: string; text: string; partId?: string }
  | { type: 'reasoning'; id: string; text: string; partId?: string }
  | { type: 'part'; id: string; part: ResponsePart }
  | { type: 'activity'; id: string; activity: ChatActivity; changes?: FileChangeSummary[] }
  | { type: 'context'; id: string; usage: ContextUsage }
  | { type: 'done' | 'error'; message: ChatMessage };
export interface ChatInput {
  requestId: string;
  text: string;
  attachmentIds: string[];
}
export interface ChatFollowup {
  id: string;
  conversationId: string;
  botId: string;
  text: string;
  state: 'queued' | 'steering' | 'applied' | 'sending' | 'sent' | 'cancelled';
  targetMessageId: string | null;
  createdAt: string;
  error: string | null;
}
export type FollowupAction =
  | { action: 'edit'; id: string; text: string }
  | { action: 'delete' | 'send'; id: string }
  | { action: 'steer'; id: string; expectedRequestId: string };
export interface ProviderTestResult {
  ok: boolean;
  message: string;
}
export const UPLOAD_LIMIT = 10 * 1024 * 1024;
export const ATTACHMENT_LIMIT = 4;
export const ACCEPTED_FILES =
  '.png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.csv,.json,.html,.xml,.ts,.js,.py,.css,.yaml,.yml,.log,.wav,.mp3,.mp4,.mov';
