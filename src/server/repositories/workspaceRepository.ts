import type { Workspace } from '../../shared/ai';
import type { Database, Row } from '../db/database';

const workspaceRecord = (row: Row): Workspace => ({
  id: String(row.id),
  name: String(row.name),
  folder: row.folder as string | null,
  createdAt: String(row.created_at),
  computer: row.computer === 'qemu' ? 'qemu' : 'local',
});
export class WorkspaceRepository {
  constructor(private database: Database) {}
  list() {
    return this.database
      .all('SELECT * FROM workspaces ORDER BY created_at,id')
      .map(workspaceRecord);
  }
  find(id: string) {
    const row = this.database.get('SELECT * FROM workspaces WHERE id = ?', id);
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
  update(workspace: Workspace) {
    this.database.run(
      'UPDATE workspaces SET name=?,folder=? WHERE id=?',
      workspace.name,
      workspace.folder,
      workspace.id,
    );
  }
}
