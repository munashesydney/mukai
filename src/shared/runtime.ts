export interface RuntimeOwner {
  workspaceId: string;
  botId: string;
  conversationId: string;
}
export type BrowserTarget = 'mukai' | 'chrome' | 'chrome-default';
export interface ChromeProfile {
  id: string;
  name: string;
  lastUsed: boolean;
}
export interface BrowserSession extends RuntimeOwner {
  id: string;
  target: BrowserTarget;
  profile?: ChromeProfile;
  url: string;
  title: string;
  createdAt: string;
  activation?: number;
}
export interface BrowserBounds {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ProcessSession extends RuntimeOwner {
  shell?: string;
  envFromSettings?: string[];
  id: string;
  command: string;
  cwd: string;
  pid: number | null;
  status: 'running' | 'exited' | 'killed' | 'failed';
  exitCode: number | null;
  createdAt: string;
}
