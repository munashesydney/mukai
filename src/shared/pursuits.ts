export type PursuitStatus =
  'active' | 'waiting' | 'blocked' | 'waiting_for_you' | 'paused' | 'completed';
export type PursuitRunStatus = 'running' | 'complete' | 'failed' | 'stopped' | 'interrupted';
export interface PursuitInput {
  name: string;
  objective: string;
  successCriteria: string;
  intervalMinutes: number;
  firstRunAt: string | null;
  deadline: string | null;
}
export interface Pursuit extends Omit<PursuitInput, 'firstRunAt'> {
  id: string;
  workspaceId: string;
  ownerBotId: string | null;
  status: PursuitStatus;
  nextRunAt: string | null;
  nextRunReason: string;
  currentRunId: string | null;
  createdAt: string;
}
export interface PursuitRun {
  id: string;
  pursuitId: string;
  conversationId: string;
  status: PursuitRunStatus;
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  error: string | null;
  snapshot: Pursuit;
}
export interface PursuitDetail {
  pursuit: Pursuit;
  runs: PursuitRun[];
}
export const pursuitStatusLabels: Record<PursuitStatus, string> = {
  active: 'Active',
  waiting: 'Waiting',
  blocked: 'Blocked',
  waiting_for_you: 'Waiting for you',
  paused: 'Paused',
  completed: 'Completed',
};
export function scheduledStatus(status: PursuitStatus) {
  return status === 'active' || status === 'waiting';
}
export function nextScheduledWake(scheduledAt: string, intervalMinutes: number, now: number) {
  const interval = intervalMinutes * 60000;
  const previous = Date.parse(scheduledAt);
  return new Date(
    previous + (Math.floor(Math.max(0, now - previous) / interval) + 1) * interval,
  ).toISOString();
}
