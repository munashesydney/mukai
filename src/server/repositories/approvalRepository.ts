import type { ApprovalMode } from '../../shared/approvals';
import type { Database } from '../db/database';

export class ApprovalRepository {
  constructor(private store: Database) {}
  mode(): ApprovalMode {
    // Preserve existing behavior when upgrading an installation without a saved policy.
    return this.store.get('SELECT value FROM metadata WHERE key = ?', 'approval-mode')?.value ===
      'ask-for-approval'
      ? 'ask-for-approval'
      : 'full-access';
  }
  setMode(mode: ApprovalMode) {
    this.store.run(
      'INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'approval-mode',
      mode,
    );
  }
}
