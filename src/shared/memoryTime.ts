import { isTimeZone, workspaceClock } from './timeZone';

const marker = '\n[Mukai episode timezone] ';

/** Persist this metadata with the episode, independently of later workspace edits. */
export function captureEpisodeTime(context: string, referenceTime: string, timeZone: string) {
  return (
    context.slice(-5000) +
    marker +
    JSON.stringify({ timeZone, referenceTime: new Date(referenceTime).toISOString() })
  );
}

export function episodeClock(
  episode: { referenceTime: string; context?: string },
  fallbackZone: string,
) {
  let timeZone = fallbackZone;
  try {
    const context = episode.context || '';
    const start = context.lastIndexOf(marker);
    if (start >= 0) {
      const saved = JSON.parse(context.slice(start + marker.length));
      if (
        isTimeZone(saved.timeZone) &&
        saved.referenceTime === new Date(episode.referenceTime).toISOString()
      )
        timeZone = saved.timeZone;
    }
  } catch {
    /* Legacy episodes use the current workspace zone; their old zone is unknown. */
  }
  return workspaceClock(episode.referenceTime, timeZone);
}
