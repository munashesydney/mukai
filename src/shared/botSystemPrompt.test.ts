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
