import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Workspace } from '../../shared/ai';
import { DEFAULT_VM_RESOURCES, type ComputerStatus } from '../../shared/computer';
import { QemuComputer } from './qemuComputer';
import { ApiError } from '../config';
import { ComputerSetupService } from './setupService';
import type { DiagnosticService } from '../services/diagnosticService';

export class ComputerManager {
  private computers = new Map<string, QemuComputer>();
  private closed = false;
  private deleting = new Set<string>();
  private onDisposing?: (computer: QemuComputer) => void;
  attachDisposalHandler(handler: (computer: QemuComputer) => void) {
    this.onDisposing = handler;
  }
  readonly installer: ComputerSetupService;
  constructor(
    private dataDir: string,
    private guestBundleDir = resolve('dist/guest'),
    private diagnostics?: DiagnosticService,
  ) {
    this.installer = new ComputerSetupService(dataDir, guestBundleDir);
  }
  initialize() {
    return this.installer.initialize();
  }
  setup() {
    return this.installer.status();
  }
  guest(workspace: Workspace) {
    if (this.deleting.has(workspace.id) || workspace.deleting)
      throw new ApiError(409, 'Workspace is being deleted.');
    if (this.closed) throw new Error('Computers are shutting down.');
    if (workspace.computer !== 'qemu')
      throw new ApiError(400, 'This workspace uses the local machine.');
    let computer = this.computers.get(workspace.id);
    if (!computer) {
      computer = new QemuComputer(
        join(this.dataDir, 'computers', workspace.id),
        this.installer.configuration(),
        undefined,
        this.guestBundleDir,
        this.diagnostics,
      );
      this.computers.set(workspace.id, computer);
    }
    computer.configureResources(workspace.computerResources || DEFAULT_VM_RESOURCES);
    return computer;
  }
  status(workspace: Workspace): ComputerStatus {
    if (workspace.computer !== 'qemu') return { kind: 'local', state: 'local' };
    const computer = this.computers.get(workspace.id);
    const resources = workspace.computerResources || DEFAULT_VM_RESOURCES;
    computer?.configureResources(resources);
    return (
      computer?.status() || {
        kind: 'qemu',
        state: 'stopped',
        resources: { ...resources },
        restartRequired: false,
      }
    );
  }
  /**
   * Heal every started workspace VM whose guest bridge may have wedged while the host
   * computer slept. Healthy bridges are detected by a probe and left alone.
   */
  async hostResumed() {
    if (this.closed) return [];
    const entries = [...this.computers];
    const results = await Promise.allSettled(
      entries.map(async ([workspaceId, computer]) => ({
        workspaceId,
        outcome: await computer.recoverAfterHostResume(),
      })),
    );
    return results.map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : { workspaceId: entries[index][0], outcome: 'failed' as const },
    );
  }
  async remove(workspace: Workspace) {
    this.deleting.add(workspace.id);
    const computer = this.computers.get(workspace.id);
    if (computer) {
      this.onDisposing?.(computer);
      await computer.shutdown();
    }
    // After an app crash, never delete a disk still owned by an orphaned QEMU.
    const pidFile = join(this.dataDir, 'computers', workspace.id, 'runtime.pid');
    try {
      const pid = Number(await readFile(pidFile, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid VM process record.');
      try {
        process.kill(pid, 0);
        throw new ApiError(
          409,
          'A previous VM process is still running. Close it, then retry deletion.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.computers.delete(workspace.id);
  }
  async shutdown() {
    this.closed = true;
    await this.installer.shutdown();
    await Promise.allSettled([...this.computers.values()].map((computer) => computer.shutdown()));
  }
}
