import { workspaceBrowserProfile } from '../browser/profile';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join, dirname, sep } from 'node:path';
import type { WorkspaceInput, WorkspaceDeletionResult } from '../../shared/ai';
import { ApiError } from '../config';
import { WorkspaceRepository } from '../repositories/workspaceRepository';
import type { ComputerManager } from '../computer/manager';
import { DEFAULT_VM_RESOURCES, vmResourcesSchema, type VmResources } from '../../shared/computer';

export class WorkspaceService {
  private deletions = new Map<string, Promise<WorkspaceDeletionResult>>();
  private stopWorkspace?: (id: string) => Promise<void>;
  attachDeletionHandler(handler: (id: string) => Promise<void>) {
    this.stopWorkspace = handler;
  }
  async waitForDeletions() {
    await Promise.allSettled([...this.deletions.values()]);
  }
  async resumeDeletions() {
    for (const workspace of this.list().filter((value) => value.deleting)) {
      await this.remove(workspace.id).catch(() => {});
    }
  }
  remove(id: string, confirmation?: string) {
    const workspace = this.workspaces.find(id, true);
    if (!workspace) throw new ApiError(404, 'Workspace not found.');
    if (confirmation !== undefined && confirmation !== workspace.name)
      throw new ApiError(400, 'Type the workspace name to confirm deletion.');
    const existing = this.deletions.get(id);
    if (existing) return existing;
    if (!this.stopWorkspace) throw new ApiError(503, 'Workspace deletion is unavailable.');
    // Persist ownership before removing files; retries retain the full cleanup list.
    const files = this.workspaces.deletionFiles(id) || [
      join('computers', id),
      join('artifacts', 'screenshots', id),
      join('browser-profiles', 'chrome', 'workspaces', workspaceBrowserProfile(id)),
      ...this.workspaces
        .ownedCapabilityVersions(id)
        .map((version) => join('capabilities', version)),
      ...this.workspaces.ownedFiles(id).map((name) => {
        if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..')
          throw new Error('Invalid stored upload name.');
        return join('uploads', name);
      }),
    ];
    const cacheKeys = this.workspaces.deletionCacheKeys(id);
    this.workspaces.beginDeletion(id, files);
    const operation = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([this.stopWorkspace!(id), this.computers?.remove(workspace)]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new ApiError(409, 'Running work did not stop in time. Retry workspace deletion.'),
                ),
              60000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      for (const file of files) await this.removePrivateFile(file, id);
      this.workspaces.remove(id);
      return { deleted: true as const, ...cacheKeys };
    })().finally(() => this.deletions.delete(id));
    this.deletions.set(id, operation);
    return operation;
  }
  private async removePrivateFile(file: string, id: string) {
    const allowed = [
      join('computers', id),
      join('artifacts', 'screenshots', id),
      join('browser-profiles', 'chrome', 'workspaces', workspaceBrowserProfile(id)),
    ];
    const upload = dirname(file) === 'uploads' && !isAbsolute(file);
    const capability =
      dirname(file) === 'capabilities' &&
      /^[a-f0-9-]{36}$/i.test(file.slice('capabilities'.length + 1));
    if (!allowed.includes(file) && !upload && !capability)
      throw new Error('Invalid workspace cleanup path.');
    const root = await realpath(this.dataDir);
    const target = resolve(root, file);
    const contained = (path: string) => {
      const part = relative(root, path);
      return !!part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
    };
    if (!contained(target)) throw new Error('Refusing cleanup outside private workspace storage.');
    // A junction in an ancestor must never redirect cleanup into a project folder.
    let ancestor = dirname(target);
    while (ancestor !== root) {
      try {
        const actual = await realpath(ancestor);
        const comparable = (path: string) =>
          process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
        if (!contained(actual) || comparable(actual) !== comparable(ancestor))
          throw new Error('Workspace storage is redirected by a junction or symlink.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        ancestor = dirname(ancestor);
      }
    }
    try {
      const info = await lstat(target);
      // rm unlinks a symlink itself rather than recursively following its target.
      await rm(target, {
        recursive: info.isDirectory() && !info.isSymbolicLink(),
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

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
      ...(computer === 'qemu' ? { computerResources: { ...DEFAULT_VM_RESOURCES } } : {}),
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
  updateComputerResources(id: string, input: VmResources) {
    const workspace = this.require(id);
    if (workspace.computer !== 'qemu')
      throw new ApiError(400, 'Computer resources apply only to Linux VM workspaces.');
    const resources = vmResourcesSchema.parse(input);
    this.workspaces.updateComputerResources(id, resources);
    return this.require(id);
  }
}
