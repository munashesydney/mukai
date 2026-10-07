import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { WorkspaceInput } from '../../shared/ai';
import { ApiError } from '../config';
import { WorkspaceRepository } from '../repositories/workspaceRepository';
import type { ComputerManager } from '../computer/manager';

export class WorkspaceService {
  constructor(
    private workspaces: WorkspaceRepository,
    private dataDir: string,
    readonly computers?: ComputerManager,
  ) {}
  list() {
    return this.workspaces.list();
  }
  require(id: string) {
    const workspace = this.workspaces.find(id);
    if (!workspace) throw new ApiError(404, 'Workspace not found.');
    return workspace;
  }
  private folder(value: string) {
    if (!isAbsolute(value))
      throw new ApiError(400, 'Choose an absolute folder path on this computer.');
    let folder: string;
    try {
      folder = realpathSync(value);
      if (!statSync(folder).isDirectory()) throw new Error();
    } catch {
      throw new ApiError(400, 'That folder is unavailable. Choose an existing, accessible folder.');
    }
    const insideData = relative(resolve(this.dataDir), folder);
    if (!insideData || (!insideData.startsWith('..') && !isAbsolute(insideData)))
      throw new ApiError(400, 'Choose a project folder outside Mukai’s private data directory.');
    return folder;
  }
  create(input: WorkspaceInput) {
    const computer = input.computer || 'local';
    const folder = computer === 'qemu' ? null : this.folder(input.folder);
    if (computer === 'qemu' && !this.computers)
      throw new ApiError(503, 'VM computers are unavailable.');
    if (folder && this.workspaces.findFolder(folder))
      throw new ApiError(
        409,
        'That folder already belongs to a workspace. Switch to it from the workspace menu.',
      );
    const workspace = {
      id: randomUUID(),
      name: input.name,
      folder,
      computer,
      createdAt: new Date().toISOString(),
    };
    this.workspaces.create(workspace);
    return workspace;
  }
  update(id: string, input: WorkspaceInput) {
    const workspace = this.require(id);
    if (workspace.computer === 'qemu' || input.computer === 'qemu')
      throw new ApiError(
        409,
        'The computer type is fixed at creation. Create a new workspace to change it.',
      );
    // Keep a workspace attached to the same folder once file tools have been used.
    if (workspace.folder)
      throw new ApiError(
        409,
        'This workspace already has a folder. Create another workspace for a different folder.',
      );
    const folder = this.folder(input.folder);
    if (this.workspaces.findFolder(folder))
      throw new ApiError(409, 'That folder already belongs to a workspace.');
    const updated = { ...workspace, name: input.name, folder };
    this.workspaces.update(updated);
    return updated;
  }
}
