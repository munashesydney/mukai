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
  async shutdown() {
    this.closed = true;
    await this.installer.shutdown();
    await Promise.allSettled([...this.computers.values()].map((computer) => computer.shutdown()));
  }
}
