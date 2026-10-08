import { expect, it } from 'vitest';
import { ProgressGuard } from './progressGuard';

it('handles huge circular results without crashing the run', () => {
  const guard = new ProgressGuard();
  const result: Record<string, unknown> = {
    text: 'x'.repeat(2000000),
    rows: Array(100000).fill('entry'),
  };
  result.self = result;
  expect(() =>
    guard.observe('file_operations', { action: 'read_file', path: 'large' }, result),
  ).not.toThrow();
  expect(guard.paused).toBe(false);
});

it('does not count new process IDs as progress for an identical command and output', () => {
  const guard = new ProgressGuard();
  for (let index = 0; index < 10; index++)
    guard.observe(
      'terminal',
      { command: 'Get-Content missing.txt' },
      {
        ok: true,
        result: {
          id: `process-${index}`,
          pid: index,
          output: 'Missing file.',
          exitCode: 1,
          status: 'exited',
        },
      },
    );
  expect(guard.paused).toBe(true);
});

it('warns before pausing unchanged requests and results, including cycles', () => {
  const guard = new ProgressGuard();
  for (let index = 0; index < 6; index++)
    guard.observe(
      'file_operations',
      { action: 'read_file', path: 'missing' },
      { ok: false, error: 'missing' },
    );
  expect(guard.notice).toContain('repeated');
  expect(guard.paused).toBe(false);
  for (let index = 0; index < 4; index++)
    guard.observe(
      'file_operations',
      { action: 'read_file', path: 'missing' },
      { ok: false, error: 'missing' },
    );
  expect(guard.paused).toBe(true);
  const cycle = new ProgressGuard();
  for (let index = 0; index < 12; index++)
    cycle.observe('file_operations', { path: index % 2 ? 'a' : 'b' }, { text: 'unchanged' });
  expect(cycle.paused).toBe(true);
});
it('allows different arguments and changed results to make progress', () => {
  const guard = new ProgressGuard();
  for (let index = 0; index < 30; index++)
    guard.observe('file_operations', { path: 'notes' }, { text: String(index) });
  expect(guard.notice).toBe('');
  expect(guard.paused).toBe(false);
});
it('does not accuse ordinary process polls or successful repeated browser interaction', () => {
  const guard = new ProgressGuard();
  for (let index = 0; index < 100; index++) {
    guard.observe('process', { action: 'poll', sessionId: 'a' }, { output: '', running: true });
    guard.observe(
      'browser',
      { action: 'click', ref: 'button', x: index, y: 1 },
      { ok: true, result: { summary: 'Clicked control.' } },
    );
    guard.observe('browser', { action: 'press', key: 'ArrowDown' }, { ok: true });
  }
  expect(guard.paused).toBe(false);
  expect(guard.notice).toBe('');
});
it('pauses repeated unchanged profile discovery instead of treating it as browser interaction', () => {
  const guard = new ProgressGuard();
  for (let index = 0; index < 10; index++)
    guard.observe(
      'browser',
      { action: 'profiles' },
      {
        ok: true,
        result: { profiles: [{ id: 'Default', name: 'Personal', lastUsed: true }] },
      },
    );
  expect(guard.notice).toContain('repeated');
  expect(guard.paused).toBe(true);
});
it('ignores rotated refs but detects unchanged browser state and resets on page progress', () => {
  const guard = new ProgressGuard();
  for (let index = 0; index < 6; index++)
    guard.observe(
      'browser',
      { action: 'snapshot', sessionId: 'a' },
      {
        ok: true,
        result: {
          url: 'https://example.com',
          text: 'same',
          controls: [{ ref: `rotated-${index}`, role: 'button', name: 'Send', value: '' }],
        },
      },
    );
  expect(guard.notice).toContain('repeated');
  guard.observe(
    'browser',
    { action: 'snapshot', sessionId: 'a' },
    { ok: true, result: { url: 'https://example.com', text: 'Reply received', controls: [] } },
  );
  expect(guard.notice).toBe('');
});
it('distinguishes failed interactions with different semantic targets or coordinates', () => {
  const guard = new ProgressGuard();
  guard.observe(
    'browser',
    { action: 'snapshot', sessionId: 'a' },
    {
      controls: [
        { ref: 'a', name: 'Next', role: 'button' },
        { ref: 'b', name: 'Back', role: 'button' },
      ],
    },
  );
  for (let index = 0; index < 20; index++)
    guard.observe(
      'browser',
      { action: 'click', ref: index % 2 ? 'a' : 'b', x: index },
      { ok: false, error: 'Disabled' },
    );
  expect(guard.notice).toBe('');
});
