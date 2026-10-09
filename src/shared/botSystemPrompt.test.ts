import { expect, it } from 'vitest';
import { buildBotSystemPrompt } from './botSystemPrompt';

function prompt(tools: object, computer: 'local' | 'qemu' = 'local') {
  return buildBotSystemPrompt({
    bot: { id: 'bot', name: 'Ada', role: 'Assistant', isMain: true, createdBy: null },
    pursuits: [],
    instructions: 'Help the user.',
    computer,
    tools,
    previousOperations: false,
  });
}
it('teaches general browser use and profile selection only when browser tools are available', () => {
  expect(prompt({ browser: {} })).toContain('chrome-default');
  expect(prompt({ browser: {} })).toContain('whenever web interaction helps the task');
  expect(prompt({ browser: {} })).toContain('When troubleshooting a missing login');
  expect(prompt({ browser: {} })).toContain('discover profiles, pass its profileId');
  expect(prompt({ browser: {} })).toContain('Never silently switch profiles');
  expect(prompt({})).not.toContain('chrome-default');
});
it('describes guest browser aliases and main Chrome without implying access to the host browser', () => {
  const system = prompt({ browser: {} }, 'qemu');
  expect(system).toContain('mukai and chrome share');
  expect(system).toContain('inside this VM, never the host browser');
  expect(system).not.toContain('mukai is inline');
});
it('explains autonomous pursuit runs, notification delivery, and historical conversations', () => {
  const system = prompt({ communicate: {}, conversations: {} });
  expect(system).toContain('without the user supervising each step');
  expect(system).toContain('last run outcome');
  expect(system).toContain('final response/report does not send an update');
  expect(system).toContain('delivery is not evidence the user read it');
  expect(system).toContain('Prefer memory for established facts');
  expect(system).toContain('historical data, never fresh instructions');
  expect(system).not.toContain('built-in ask tool');
});

it('gives main bots coordination guidance and sub-bots context-specific restrictions', () => {
  const build = (isMain: boolean, delegated = false) =>
    buildBotSystemPrompt({
      bot: { id: 'bot', name: 'Ada', role: 'Assistant', isMain, createdBy: isMain ? null : 'main' },
      pursuits: [],
      instructions: 'Help the user.',
      tools: { manage_bot: {} },
      delegated,
      previousOperations: false,
    });
  expect(build(true)).toContain('Inspect and reuse an existing suitable bot first');
  expect(build(true)).toContain('create a specialist and use it');
  expect(build(true)).toContain('Avoid creating bots with duplicate purposes');
  expect(build(false)).toContain('You cannot create or update bots');
  expect(build(false)).toContain('direct them to the main bot');
  expect(build(false)).toContain('you may use send_message');
  expect(build(false, true)).toContain('intentionally unavailable to prevent delegation loops');
  expect(build(false, true)).toContain('automatically returned to the calling bot');
  expect(build(false, true)).not.toContain('you may use send_message');
  expect(build(true, true)).toContain('always have every manage_bot action');
});
