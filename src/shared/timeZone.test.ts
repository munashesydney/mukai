import { expect, it } from 'vitest';
import { formatTimestamp, isTimeZone, workspaceClock } from './timeZone';
import { captureEpisodeTime, episodeClock } from './memoryTime';

it('validates timezone identifiers without accepting ambiguous abbreviations or offsets', () => {
  for (const zone of ['UTC', 'America/Vancouver', 'Asia/Kathmandu', 'Pacific/Chatham'])
    expect(isTimeZone(zone)).toBe(true);
  for (const zone of ['PST', '-08:00', 'Vancouver', 'Mars/Olympus', '', null])
    expect(isTimeZone(zone)).toBe(false);
});

it('computes the local date, weekday and offset from the same instant at midnight and across DST', () => {
  expect(workspaceClock('2025-01-16T07:30:00Z', 'America/Vancouver')).toMatchObject({
    localNow: '2025-01-15T23:30:00-08:00',
    localDate: '2025-01-15',
    weekday: 'Wednesday',
  });
  expect(workspaceClock('2025-03-09T09:59:59Z', 'America/Vancouver').localNow).toBe(
    '2025-03-09T01:59:59-08:00',
  );
  expect(workspaceClock('2025-03-09T10:00:00Z', 'America/Vancouver').localNow).toBe(
    '2025-03-09T03:00:00-07:00',
  );
  expect(workspaceClock('2025-11-02T08:30:00Z', 'America/Vancouver').localNow).toBe(
    '2025-11-02T01:30:00-07:00',
  );
  expect(workspaceClock('2025-11-02T09:30:00Z', 'America/Vancouver').localNow).toBe(
    '2025-11-02T01:30:00-08:00',
  );
  expect(workspaceClock('2025-01-16T00:00:00Z', 'Asia/Kathmandu').localNow).toBe(
    '2025-01-16T05:45:00+05:45',
  );
  expect(workspaceClock('2025-01-16T00:00:00Z', 'UTC').localNow).toBe('2025-01-16T00:00:00+00:00');
});

it('formats in an explicit zone and handles invalid historical timestamps', () => {
  expect(
    formatTimestamp(
      '2025-01-16T07:30:00Z',
      'America/Vancouver',
      { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
      'en',
    ),
  ).toBe('23:30');
  expect(formatTimestamp('invalid', 'UTC')).toBe('—');
});

it('uses the bundled current rules instead of the runtime ICU timezone database', () => {
  expect(workspaceClock('2026-11-05T02:00:00Z', 'America/Vancouver').localNow).toBe(
    '2026-11-04T19:00:00-07:00',
  );
  expect(
    formatTimestamp(
      '2026-11-05T02:00:00Z',
      'America/Vancouver',
      { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
      'en',
    ),
  ).toBe('19:00');
});

it('preserves the historical memory clock after a workspace timezone changes', () => {
  const referenceTime = '2025-01-16T07:30:00Z';
  const context = captureEpisodeTime(
    'old context'.repeat(1000),
    referenceTime,
    'America/Vancouver',
  );
  expect(context.length).toBeLessThan(6000);
  expect(episodeClock({ referenceTime, context }, 'Asia/Tokyo')).toMatchObject({
    timeZone: 'America/Vancouver',
    localDate: '2025-01-15',
  });
  expect(episodeClock({ referenceTime }, 'Asia/Tokyo').localDate).toBe('2025-01-16');
});
