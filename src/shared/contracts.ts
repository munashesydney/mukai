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
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

export const IPC = {
  health: 'mukai:health',
  apiConnection: 'mukai:api-connection',
  openExternal: 'mukai:open-external',
  minimize: 'mukai:minimize',
  maximize: 'mukai:maximize',
  close: 'mukai:close',
} as const;
