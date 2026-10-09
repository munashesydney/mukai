export type PursuitStatus =
  'active' | 'waiting' | 'blocked' | 'waiting_for_you' | 'paused' | 'completed';
export type PursuitRunStatus = 'running' | 'complete' | 'failed' | 'stopped' | 'interrupted';
export interface PursuitInput {
  name: string;
  objective: string;
  successCriteria: string;
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
  nextRunInstructions: string;
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
export const workpadEntryTypes = ['work_item', 'decision', 'blocker', 'reference', 'note'] as const;
export type WorkpadEntryType = (typeof workpadEntryTypes)[number];
export const workpadStatuses = [
  'todo',
  'in_progress',
  'done',
  'open',
  'resolved',
  'active',
  'archived',
] as const;
export type WorkpadStatus = (typeof workpadStatuses)[number];
export const workpadTypeLabels: Record<WorkpadEntryType, string> = {
  work_item: 'Work item',
  decision: 'Decision',
  blocker: 'Blocker',
  reference: 'Reference',
  note: 'Note',
};
export const workpadStatusLabels: Record<WorkpadStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  open: 'Open',
  resolved: 'Resolved',
  active: 'Active',
  archived: 'Archived',
};
export function validWorkpadStatus(type: WorkpadEntryType, status: WorkpadStatus) {
  return (
    status === 'archived' ||
    (type === 'work_item'
      ? ['todo', 'in_progress', 'done'].includes(status)
      : type === 'blocker'
        ? ['open', 'resolved'].includes(status)
        : status === 'active')
  );
}
export interface WorkpadLink {
  kind: 'file' | 'url' | 'conversation' | 'artifact' | 'entry';
  target: string;
  label: string;
}
export interface WorkpadEntryInput {
  type: WorkpadEntryType;
  title: string;
  content: string;
  status?: WorkpadStatus;
  links?: WorkpadLink[];
}
export type WorkpadEntryPatch = Partial<Omit<WorkpadEntryInput, 'type'>>;
export interface WorkpadEntry extends Omit<WorkpadEntryInput, 'status' | 'links'> {
  id: string;
  pursuitId: string;
  status: WorkpadStatus;
  links: WorkpadLink[];
  authorBotId: string | null;
  originRunId: string | null;
  updatedRunId: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface WorkpadQuery {
  type?: WorkpadEntryType;
  status?: WorkpadStatus;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}
export interface WorkpadPage {
  entries: WorkpadEntry[];
  total: number;
  nextOffset: number | null;
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
