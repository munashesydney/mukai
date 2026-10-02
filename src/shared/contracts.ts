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
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

export const IPC = {
  health: 'mukai:health',
  minimize: 'mukai:minimize',
  maximize: 'mukai:maximize',
  close: 'mukai:close',
} as const;
