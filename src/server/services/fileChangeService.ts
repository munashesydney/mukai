import { ApiError } from '../config';
import { FileChangeRepository } from '../repositories/fileChangeRepository';
import type { FileMutationSnapshot } from '../../shared/fileChanges';

export class FileChangeService {
  constructor(private changes: FileChangeRepository) {}
  detail(id: string) {
    const change = this.changes.find(id);
    if (!change) throw new ApiError(404, 'File change not found.');
    return change;
  }
  record(botId: string, messageId: string, snapshot: FileMutationSnapshot) {
    this.changes.record(botId, messageId, snapshot);
  }
}
