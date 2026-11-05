import { createContext, useContext } from 'react';
import { effectiveTimeZone, formatTimestamp } from '../../../../shared/timeZone';

export const WorkspaceTimeContext = createContext<{
  timeZone: string;
  zones: Record<string, string>;
}>({ timeZone: 'UTC', zones: {} });

export function useWorkspaceTime() {
  const { timeZone, zones } = useContext(WorkspaceTimeContext);
  return {
    timeZone,
    zoneFor: (workspaceId: string) => effectiveTimeZone(zones[workspaceId]),
    dateTime: (value: string | number | Date) => formatTimestamp(value, timeZone),
    time: (value: string | number | Date) =>
      formatTimestamp(value, timeZone, { hour: 'numeric', minute: '2-digit' }),
    date: (value: string | number | Date) =>
      formatTimestamp(value, timeZone, { month: 'short', day: 'numeric' }),
  };
}
