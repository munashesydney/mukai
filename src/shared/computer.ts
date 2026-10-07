export type ComputerKind = 'local' | 'qemu';
export interface ComputerStatus {
  kind: ComputerKind;
  state: 'local' | 'stopped' | 'starting' | 'running' | 'failed';
  error?: string;
}
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
  downloadedBytes?: number;
  totalBytes?: number;
}
