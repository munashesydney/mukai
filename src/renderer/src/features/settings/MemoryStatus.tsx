import { CircleAlert, CircleCheck, Clock3, LoaderCircle } from 'lucide-react';
import type { MemoryWorkStatus } from './memoryWorkStatus';

const statusDisplay = {
  queued: { label: 'Queued', tone: 'waiting', icon: Clock3 },
  scheduled: { label: 'Retry scheduled', tone: 'waiting', icon: Clock3 },
  retryQueued: { label: 'Retry queued', tone: 'waiting', icon: Clock3 },
  running: { label: 'Running', tone: 'active', icon: LoaderCircle },
  retrying: { label: 'Retrying', tone: 'active', icon: LoaderCircle },
  failed: { label: 'Needs attention', tone: 'failed', icon: CircleAlert },
  pastFailure: { label: 'Failed attempt', tone: 'neutral', icon: CircleAlert },
  complete: { label: 'Complete', tone: 'complete', icon: CircleCheck },
} as const;

export function MemoryStatus({ status }: { status: MemoryWorkStatus }) {
  const { label, tone, icon: Icon } = statusDisplay[status];
  return (
    <span className={`memory-status memory-status--${tone}`}>
      <Icon size={13} aria-hidden="true" />
      {label}
    </span>
  );
}
