import type { AIActivity } from '../../../../shared/aiActivity';

/** Work in every workspace, including pursuits between provider calls. */
export function runningWorkspaceIds(activity: AIActivity): Set<string> {
  return new Set(
    [
      ...(activity.workingWorkspaceIds ?? []),
      ...[...activity.running, ...(activity.pursuitRunning ?? [])].map((work) => work.workspaceId),
    ].filter((id): id is string => Boolean(id)),
  );
}
