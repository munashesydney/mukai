import { ApiError } from '../config';
import type { Workspace } from '../../shared/ai';
import type { Database, Row } from '../db/database';
import type { VmResources } from '../../shared/computer';

const workspaceRecord = (row: Row): Workspace => ({
  id: String(row.id),
  name: String(row.name),
  folder: row.folder as string | null,
  createdAt: String(row.created_at),
  ...(row.deleting ? { deleting: true } : {}),
  computer: row.computer === 'qemu' ? 'qemu' : 'local',
  ...(row.computer === 'qemu'
    ? {
        computerResources: { memoryMiB: Number(row.vm_memory_mib), vcpus: Number(row.vm_vcpus) },
      }
    : {}),
});
export class WorkspaceRepository {
  constructor(private database: Database) {}
  list() {
    return this.database
      .all('SELECT * FROM workspaces ORDER BY created_at,id')
      .map(workspaceRecord);
  }
  find(id: string, includeDeleting = false) {
    const row = this.database.get('SELECT * FROM workspaces WHERE id = ?', id);
    if (row?.deleting && !includeDeleting)
      throw new ApiError(
        409,
        'This workspace is being deleted. Retry deletion from workspace settings.',
      );
    return row ? workspaceRecord(row) : undefined;
  }
  findFolder(folder: string) {
    const row = this.database.get(
      'SELECT * FROM workspaces WHERE folder = ? COLLATE NOCASE',
      folder,
    );
    return row ? workspaceRecord(row) : undefined;
  }
  create(workspace: Workspace) {
    this.database.transaction(() => {
      this.database.run(
        'INSERT INTO workspaces (id,name,folder,created_at,computer) VALUES (?,?,?,?,?)',
        workspace.id,
        workspace.name,
        workspace.folder,
        workspace.createdAt,
        workspace.computer || 'local',
      );
    });
  }
  deletionCacheKeys(id: string) {
    return {
      botIds: this.database
        .all('SELECT id FROM bots WHERE workspace_id=?', id)
        .map((row) => String(row.id)),
      conversationIds: this.database
        .all('SELECT id FROM conversations WHERE workspace_id=?', id)
        .map((row) => String(row.id)),
    };
  }
  deletionFiles(id: string): string[] | undefined {
    const row = this.database.get('SELECT deletion_files_json FROM workspaces WHERE id=?', id);
    return row?.deletion_files_json ? JSON.parse(String(row.deletion_files_json)) : undefined;
  }
  beginDeletion(id: string, files: string[]) {
    this.database.run(
      'UPDATE workspaces SET deleting=1,deletion_files_json=? WHERE id=?',
      JSON.stringify(files),
      id,
    );
  }
  ownedFiles(id: string) {
    return this.database
      .all(
        `SELECT storage_name FROM attachments WHERE bot_id IN
      (SELECT id FROM bots WHERE workspace_id=?) OR conversation_id IN
      (SELECT id FROM conversations WHERE workspace_id=?)`,
        id,
        id,
      )
      .map((row) => String(row.storage_name))
      .filter(
        (name) =>
          !this.database.get(
            `SELECT a.id FROM attachments a JOIN bots b ON b.id=a.bot_id
        WHERE a.storage_name=? AND b.workspace_id!=? LIMIT 1`,
            name,
            id,
          ),
      );
  }
  ownedCapabilityVersions(id: string) {
    return this.database
      .all(
        `SELECT version FROM workspace_capability_versions WHERE workspace_id=? UNION
      SELECT version FROM capabilities WHERE workspace_id=? UNION
      SELECT r.version FROM capability_runs r JOIN capabilities c ON c.id=r.capability_id WHERE c.workspace_id=? UNION
      SELECT j.version FROM capability_jobs j JOIN capabilities c ON c.id=j.capability_id WHERE c.workspace_id=?`,
        id,
        id,
        id,
        id,
      )
      .map((row) => String(row.version))
      .filter(
        (version) =>
          !this.database.get(
            `SELECT id FROM capabilities WHERE workspace_id!=? AND version=? UNION
        SELECT r.id FROM capability_runs r JOIN capabilities c ON c.id=r.capability_id WHERE c.workspace_id!=? AND r.version=? UNION
        SELECT j.id FROM capability_jobs j JOIN capabilities c ON c.id=j.capability_id WHERE c.workspace_id!=? AND j.version=?`,
            id,
            version,
            id,
            version,
            id,
            version,
          ),
      );
  }
  remove(id: string) {
    this.database.transaction(() => {
      // Memory storage deliberately has no FK to the application's workspace table.
      if (this.database.get("SELECT name FROM sqlite_master WHERE name='memory_facts'")) {
        this.database.run(
          'DELETE FROM memory_fts WHERE fact_id IN (SELECT id FROM memory_facts WHERE workspace_id=?)',
          id,
        );
        for (const table of [
          'memory_facts',
          'memory_aliases',
          'memory_entities',
          'memory_episodes',
          'memory_recalls',
          'memory_settings',
        ])
          this.database.run(`DELETE FROM ${table} WHERE workspace_id=?`, id);
      }
      this.database.run(
        'DELETE FROM pursuit_runs WHERE pursuit_id IN (SELECT id FROM pursuits WHERE workspace_id=?)',
        id,
      );
      this.database.run('DELETE FROM pursuits WHERE workspace_id=?', id);
      this.database.run('DELETE FROM conversations WHERE workspace_id=?', id);
      // Break the parent RESTRICT relationship before deleting the entire bot tree.
      this.database.run('UPDATE bots SET created_by=NULL WHERE workspace_id=?', id);
      this.database.run('DELETE FROM bots WHERE workspace_id=?', id);
      this.database.run(
        'DELETE FROM metadata WHERE key IN (?,?)',
        'approval-mode:' + id,
        'space_import:' + id,
      );
      this.database.run('DELETE FROM workspaces WHERE id=?', id);
    });
  }
  update(workspace: Workspace) {
    this.database.run(
      'UPDATE workspaces SET name=?,folder=? WHERE id=?',
      workspace.name,
      workspace.folder,
      workspace.id,
    );
  }
  updateComputerResources(id: string, resources: VmResources) {
    this.database.run(
      'UPDATE workspaces SET vm_memory_mib=?,vm_vcpus=? WHERE id=?',
      resources.memoryMiB,
      resources.vcpus,
      id,
    );
  }
}
