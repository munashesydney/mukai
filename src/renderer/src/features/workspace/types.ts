export type Section =
  'spaces' | 'pursuits' | 'bots' | 'tools' | 'settings' | 'notifications' | 'failed' | 'telegram';
export type SettingsSection =
  | 'timezone'
  | 'workspace'
  | 'appearance'
  | 'updates'
  | 'providers'
  | 'environment'
  | 'memory'
  | 'routes'
  | 'api'
  | 'limits';
export type BotId = 'atlas' | 'nova' | 'scout';
export type PersonId = BotId | 'munashe';
export interface Bot {
  id: BotId;
  name: string;
  role: string;
  color: string;
}
export interface Space {
  id: string;
  name: string;
  description: string;
  unread?: number;
}
export interface Pursuit {
  id: string;
  name: string;
  bot: BotId;
  description: string;
  progress: number;
  paused?: boolean;
}
export interface Message {
  createdAt?: string;
  id: string;
  author: PersonId;
  time: string;
  text: string;
  card?: 'pursuit' | 'draft';
  reaction?: string;
  attachment?: string;
}
export interface Location {
  section: Section;
  item: string;
  conversationId?: string;
  view?: 'pending-approvals';
  runId?: string;
}
export type DialogKind = 'draft' | 'details' | 'create-bot' | 'create-space' | null;
