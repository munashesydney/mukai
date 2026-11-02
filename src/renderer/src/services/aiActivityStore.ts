import { useSyncExternalStore } from 'react';
import type { AIActivity } from '../../../shared/aiActivity';
import { api } from './http';
import { startPoll, type PollHandle } from './poll';
const empty: AIActivity = { limit: 4, running: [], queued: [] };
let activity = empty;
let poll: PollHandle | undefined;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  poll ??= startPoll(
    async () => {
      try {
        const next = await api<AIActivity>('/ai-activity');
        if (JSON.stringify(next) === JSON.stringify(activity)) return false;
        activity = next;
      } catch {
        activity = empty;
      }
      listeners.forEach((item) => item());
    },
    { interval: 1000, maxInterval: 3000 },
  );
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      poll?.stop();
      poll = undefined;
      activity = empty;
    }
  };
}
export function useAIActivity() {
  return useSyncExternalStore(
    subscribe,
    () => activity,
    () => empty,
  );
}
