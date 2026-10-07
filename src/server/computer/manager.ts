import { join } from 'node:path';
import type { Workspace } from '../../shared/ai';
import type { ComputerStatus } from '../../shared/computer';
import { QemuComputer, qemuSetup } from './qemuComputer';
import { ApiError } from '../config';

export class ComputerManager {
  private computers = new Map<string, QemuComputer>();
  private closed = false;
  constructor(private dataDir: string) {}
  setup() {
    return qemuSetup();
  }
  guest(workspace: Workspace) {
    if (this.closed) throw new Error('Computers are shutting down.');
    if (workspace.computer !== 'qemu')
      throw new ApiError(400, 'This workspace uses the local machine.');
    let computer = this.computers.get(workspace.id);
    if (!computer) {
      computer = new QemuComputer(join(this.dataDir, 'computers', workspace.id));
      this.computers.set(workspace.id, computer);
    }
    return computer;
  }
  status(workspace: Workspace): ComputerStatus {
    return workspace.computer === 'qemu'
      ? this.computers.get(workspace.id)?.status() || { kind: 'qemu', state: 'stopped' }
      : { kind: 'local', state: 'local' };
  }
  async shutdown() {
    this.closed = true;
    await Promise.allSettled([...this.computers.values()].map((computer) => computer.shutdown()));
  }
}
