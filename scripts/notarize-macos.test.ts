import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notarizeWithTicketRetry } from './notarize-macos';

const options = {
  appPath: '/release/Mukai.app',
  appleId: 'fixture',
  appleIdPassword: 'fixture',
  teamId: 'fixture',
};
const libraryFailure = () =>
  new Error(
    'Failed to staple your application with code: 68\nNSURLErrorDomain: The network connection was lost.',
  );
const ticketFailure = () =>
  Object.assign(new Error('Command failed: xcrun stapler staple'), {
    code: 68,
    stderr: 'NSURLErrorDomain: The network connection was lost.',
  });
function fixture(notarizationFailure?: Error, attachmentFailures: Error[] = []) {
  const calls = { submissions: 0, attachments: [] as string[], waits: [] as number[] };
  return {
    calls,
    tools: {
      notarize: async () => {
        calls.submissions++;
        if (notarizationFailure) throw notarizationFailure;
      },
      staple: async (path: string) => {
        calls.attachments.push(path);
        const error = attachmentFailures.shift();
        if (error) throw error;
      },
      pause: async (milliseconds: number) => {
        calls.waits.push(milliseconds);
      },
      log: () => {},
    },
  };
}
test('successful notarization does not submit or staple again', async () => {
  const { calls, tools } = fixture();
  await notarizeWithTicketRetry(options, tools);
  assert.equal(calls.submissions, 1);
  assert.deepEqual(calls.attachments, []);
  assert.deepEqual(calls.waits, []);
});
test('a ticket network failure retries attachment to the accepted app without resubmission', async () => {
  const { calls, tools } = fixture(libraryFailure(), [ticketFailure()]);
  await notarizeWithTicketRetry(options, tools);
  assert.equal(calls.submissions, 1);
  assert.deepEqual(calls.attachments, [options.appPath, options.appPath]);
  assert.deepEqual(calls.waits, [10000, 20000]);
});
test('authentication failures and rejected notarizations remain fatal', async () => {
  for (const error of [
    new Error('Invalid Apple credentials'),
    new Error('Failed to notarize via notarytool: Invalid'),
    new Error('Failed to staple your application with code: 68\nNo ticket found'),
  ]) {
    const { calls, tools } = fixture(error);
    await assert.rejects(notarizeWithTicketRetry(options, tools), (value) => value === error);
    assert.deepEqual(calls.attachments, []);
    assert.deepEqual(calls.waits, []);
  }
});
test('permanent stapling errors fail immediately and network retries are bounded', async () => {
  const permanent = Object.assign(new Error('Invalid application bundle'), { code: 65 });
  const first = fixture(libraryFailure(), [permanent]);
  await assert.rejects(
    notarizeWithTicketRetry(options, first.tools),
    (value) => value === permanent,
  );
  assert.equal(first.calls.attachments.length, 1);
  const failures = Array.from({ length: 5 }, ticketFailure);
  const last = failures[4];
  const second = fixture(libraryFailure(), failures);
  await assert.rejects(notarizeWithTicketRetry(options, second.tools), (value) => value === last);
  assert.equal(second.calls.submissions, 1);
  assert.equal(second.calls.attachments.length, 5);
  assert.deepEqual(second.calls.waits, [10000, 20000, 30000, 40000, 50000]);
});
