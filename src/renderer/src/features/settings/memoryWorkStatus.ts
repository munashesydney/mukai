import type { Episode, MemoryReviewRun } from '../../../../shared/memory';

export type MemoryWorkStatus =
  | 'queued'
  | 'scheduled'
  | 'retryQueued'
  | 'running'
  | 'retrying'
  | 'failed'
  | 'pastFailure'
  | 'complete';

export function reviewStatus(run: MemoryReviewRun): MemoryWorkStatus {
  if (run.status === 'running') return run.retrying ? 'retrying' : 'running';
  if (run.status === 'complete') return 'complete';
  if (!run.canRetry) return 'pastFailure';
  if (run.retryAt == null) return 'failed';
  return run.retryAt > Date.now() ? 'scheduled' : 'retryQueued';
}

export function captureStatus(episode: Episode): MemoryWorkStatus {
  if (episode.status === 'processing') return episode.attempts > 1 ? 'retrying' : 'running';
  if (episode.status === 'pending') return episode.attempts ? 'retryQueued' : 'queued';
  if (episode.status === 'failed') {
    if (episode.retryAt == null) return 'failed';
    return episode.retryAt > Date.now() ? 'scheduled' : 'retryQueued';
  }
  return 'complete';
}
