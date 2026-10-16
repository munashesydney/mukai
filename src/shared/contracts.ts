export interface HealthResponse {
  status: 'ok';
  service: 'mukai-api';
  version: string;
  uptime: number;
  timestamp: string;
}

export interface DesktopBridge {
  platform: string;
  getHealth: () => Promise<HealthResponse>;
  getApiConnection: () => Promise<{ url: string; token: string }>;
  openExternal: (url: string) => Promise<void>;
  writeClipboardText: (text: string) => Promise<void>;
  chooseWorkspaceFolder: () => Promise<string | null>;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  setBrowserBounds: (value: import('./runtime').BrowserBounds | null) => Promise<void>;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdates: () => Promise<DesktopUpdateState>;
  restartToUpdate: () => Promise<void>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

export interface DesktopUpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  version?: string;
  percent?: number;
  message?: string;
}

export const IPC = {
  health: 'mukai:health',
  apiConnection: 'mukai:api-connection',
  openExternal: 'mukai:open-external',
  writeClipboardText: 'mukai:write-clipboard-text',
  chooseWorkspaceFolder: 'mukai:choose-workspace-folder',
  minimize: 'mukai:minimize',
  maximize: 'mukai:maximize',
  close: 'mukai:close',
  browserBounds: 'mukai:browser-bounds',
  updateState: 'mukai:update-state',
  checkForUpdates: 'mukai:check-for-updates',
  restartToUpdate: 'mukai:restart-to-update',
} as const;
