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
it('teaches profile selection and existing logins only when browser tools are available', () => {
  expect(prompt({ browser: {} })).toContain('chrome-default');
  expect(prompt({ browser: {} })).toContain('check which browser/profile they used');
  expect(prompt({ browser: {} })).toContain('Never silently switch profiles');
  expect(prompt({})).not.toContain('chrome-default');
});
it('describes guest browser aliases and main Chrome without implying access to the host browser', () => {
  const system = prompt({ browser: {} }, 'qemu');
  expect(system).toContain('mukai and chrome share');
  expect(system).toContain('inside this VM, never the host browser');
  expect(system).not.toContain('mukai is inline');
});
