import moment from 'moment-timezone';

/** Bundle one rule database: Electron Chromium and a shared Node backend can have different ICU data. */
export const timeZoneDataVersion = moment.tz.dataVersion;
export const timeZoneNames = () =>
  moment.tz.names().filter((name) => name === 'UTC' || name.includes('/'));

/** Timezones describe presentation and calendar intent; stored instants remain UTC. */
export function isTimeZone(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 100 ||
    !/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value)
  )
    return false;
  return moment.tz.zone(value) !== null;
}

export function detectTimeZone(): string {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(value) ? value : 'UTC';
  } catch {
    return 'UTC';
  }
}

export const effectiveTimeZone = (value?: string | null) =>
  isTimeZone(value) ? value : detectTimeZone();

export function formatTimestamp(
  value: string | number | Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  locale?: string,
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    ...options,
    // Intl supplies locale formatting only; the bundled rules supply the offset.
    timeZone: moment.tz(date, effectiveTimeZone(timeZone)).format('Z'),
  }).format(date);
}

/** All clock fields come from one instant, including the offset for that instant. */
export function workspaceClock(now: string | number | Date, timeZone: string) {
  const date = new Date(now);
  const zone = effectiveTimeZone(timeZone);
  const local = moment.tz(date, zone).locale('en');
  const offset = local.format('Z');
  const localDate = local.format('YYYY-MM-DD');
  return {
    timeZone: zone,
    utcNow: date.toISOString(),
    localNow: local.format('YYYY-MM-DDTHH:mm:ssZ'),
    localDate,
    weekday: local.format('dddd'),
    offset,
  };
}
