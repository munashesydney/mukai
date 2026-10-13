import { z } from 'zod';

export const DEFAULT_VM_RESOURCES = { memoryMiB: 4096, vcpus: 2 } as const;
export const vmResourcesSchema = z
  .object({
    memoryMiB: z.number().int().min(1024).max(65536).multipleOf(256),
    vcpus: z.number().int().min(1).max(32),
  })
  .strict();
export type VmResources = z.infer<typeof vmResourcesSchema>;

export type ComputerKind = 'local' | 'qemu';
export interface ComputerStatus {
  kind: ComputerKind;
  state: 'local' | 'stopped' | 'starting' | 'running' | 'failed';
  error?: string;
  message?: string;
  detail?: string;
  resources?: VmResources;
  activeResources?: VmResources;
  restartRequired?: boolean;
}
export interface ComputerViewSession {
  path: string;
  password: string;
}
export interface QemuSetup {
  available: boolean;
  warning?: string;
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
