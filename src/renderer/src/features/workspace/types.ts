export type Section = 'spaces' | 'pursuits' | 'agents' | 'tools';
export type AgentId = 'atlas' | 'nova' | 'scout';
export type PersonId = AgentId | 'munashe';
export interface Agent {
  id: AgentId;
  name: string;
  role: string;
  description: string;
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
  agent: AgentId;
  description: string;
  progress: number;
  paused?: boolean;
}
export interface Message {
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
}
export type DialogKind =
  'draft' | 'details' | 'settings' | 'create-agent' | 'create-space' | 'create-pursuit' | null;
