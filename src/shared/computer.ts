export type ComputerKind = 'local' | 'qemu';
export interface ComputerStatus {
  kind: ComputerKind;
  state: 'local' | 'stopped' | 'starting' | 'running' | 'failed';
  error?: string;
  message?: string;
  detail?: string;
}
export interface ComputerViewSession { path: string; password: string; }
export interface QemuSetup {
  available: boolean;
  reason?: string;
  phase?:
    | 'idle'
    | 'checking'
    | 'installing'
    | 'downloading'
    | 'preparing'
    | 'verifying'
    | 'ready'
    | 'reboot-required'
    | 'failed';
  message?: string;
  detail?: string;
  downloadedBytes?: number;
  totalBytes?: number;
}
