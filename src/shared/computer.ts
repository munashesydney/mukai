export type ComputerKind = 'local' | 'qemu';
export interface ComputerStatus {
  kind: ComputerKind;
  state: 'local' | 'stopped' | 'starting' | 'running' | 'failed';
  error?: string;
}
export interface QemuSetup {
  available: boolean;
  reason?: string;
}
