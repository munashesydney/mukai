import { expect, it, vi } from 'vitest';
import { buildBotSystemPrompt, buildBotRuntimeContext } from './botSystemPrompt';
import { mukaiEnvironmentInstructions as v1 } from './prompts/mukaiv1';
import {
  mukaiEnvironmentInstructions as v2,
  mukaiMainBotInstructions,
  mukaiPursuitInstructions,
  mukaiPursuitRunInstructions,
  mukaiSecretsInstructions,
  mukaiSkillInstructions,
} from './prompts/mukaiv2';

function prompt(tools: object, computer: 'local' | 'qemu' = 'local') {
  return buildBotSystemPrompt({
    bot: { id: 'bot', name: 'Ada', role: 'Assistant', isMain: true, createdBy: null },
    instructions: 'Help the user.',
    workspace: { id: 'workspace', name: 'Test workspace' },
    computer,
    tools,
  });
}
it('uses the role-neutral v2 shared prompt and leaves v1 available separately', () => {
  expect(prompt({}).startsWith(v2 + '\n')).toBe(true);
  expect(prompt({})).not.toContain(v1);
  expect(v2).toContain('### Communicate clearly');
  expect(v2).toContain('answer it briefly and continue the original task');
  expect(v2).toContain('Call only tools and actions supplied in the current run');
  expect(v2).toContain('the communicate tool and approvals also message the user on Telegram');
  expect(v2).not.toContain("You are the workspace's main bot");
  expect(v1).toContain('Your default question is:');
});

it('includes the current workspace Telegram connection status', () => {
  const build = (telegramConnected: boolean) =>
    buildBotSystemPrompt({
      bot: { id: 'bot', name: 'Ada', role: 'Assistant', isMain: true, createdBy: null },
      instructions: 'Help the user.',
      workspace: { id: 'workspace', name: 'Test workspace' },
      telegramConnected,
      tools: {},
    });
  for (const connected of [true, false])
    expect(build(connected)).toContain(
      'Telegram connected for current workspace (paired, enabled, workspace authorized): ' +
        connected,
    );
});

it('keeps shared and conditional guidance close to the v1 instruction budget', () => {
  const guidance = [
    v2,
    mukaiMainBotInstructions,
    mukaiPursuitInstructions,
    mukaiSecretsInstructions,
    mukaiSkillInstructions,
  ].join('\n');
  // The initial expanded draft triggered premature compaction in smaller contexts.
  expect(Buffer.byteLength(guidance)).toBeLessThanOrEqual(Buffer.byteLength(v1) * 1.2);
});

it('teaches Mukai capabilities to every role even with no tools assigned', () => {
  for (const isMain of [true, false])
    for (const delegated of [true, false]) {
      const system = buildBotSystemPrompt({
        bot: { id: 'bot', name: 'Ada', role: 'Assistant', isMain, createdBy: null },
        instructions: 'Help.',
        workspace: { id: 'workspace', name: 'Test workspace' },
        tools: {},
        delegated,
      });
      for (const concept of [
        '### Know Mukai',
        'separate pursuit_run conversation with fresh context',
        'Reports do not notify users',
        'The AI performing each run reports its outcome and chooses its next wake time',
        'Only the main bot can create bots',
        'Settings → Environment Variables',
        'Skills are reusable workflows',
        'Memory is user-controlled',
        'Custom tools and hosted routes',
        'custom jobs run scheduled code',
        'Registration is not execution: verify history and effects',
        'Shared spaces',
        'model-dependent image/audio/video inspection',
        'Missing access is not proof a feature does not exist',
      ])
        expect(system).toContain(concept);
      expect(system).not.toContain('You are performing a pursuit run');
      expect(system).not.toContain('Before your final answer, you MUST call report_pursuit');
      expect(system.includes("You are the workspace's main bot")).toBe(isMain);
    }
});
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
  const system = prompt({ communicate: {}, conversations: {}, manage_pursuit: {} });
  expect(system).toContain(mukaiPursuitInstructions);
  expect(system).toContain('cannot finish in the current conversation');
  expect(system).toContain('check for an overlapping one');
  expect(system).toContain('independently perform the same work');
  expect(system).toContain('delivery is not evidence the user read it');
  expect(system).toContain('when memory is enabled');
  expect(system).toContain('historical data, never fresh instructions');
  expect(system).not.toContain('report_pursuit');
  expect(prompt({})).not.toContain(mukaiPursuitInstructions);
});

it('includes pursuit reporting only in runs with a reporting tool', () => {
  for (const tools of [{ report_pursuit: {} }, { report_pursuit: {}, manage_pursuit: {} }]) {
    const system = prompt(tools);
    expect(system).toContain(mukaiPursuitRunInstructions);
    expect(system).not.toContain(mukaiPursuitInstructions);
    expect(system).toContain('Before your final answer, you MUST call report_pursuit');
    expect(system).toContain('Set all three scheduling fields to null for other outcomes');
    expect(system).toContain('Do not create additional pursuits during this run');
    expect(system).toContain('Keep monitoring quiet when nothing actionable has changed');
  }
  expect(prompt({})).not.toContain(mukaiPursuitRunInstructions);
  expect(prompt({})).not.toContain('report_pursuit');
});

it('includes credential mechanics only when a tool can discover or use environment variables', () => {
  for (const name of ['system', 'terminal', 'register_custom_tool', 'register_custom_route'])
    expect(prompt({ [name]: {} })).toContain(mukaiSecretsInstructions);
  expect(prompt({ web_search: {} })).not.toContain(mukaiSecretsInstructions);
  expect(prompt({})).not.toContain('envFromSettings');
});

it('recommends procedural self-improvement and explains available skill operations', () => {
  const system = prompt({ skills: {} });
  expect(system).toContain(mukaiSkillInstructions);
  expect(system).toContain('optional follow-through, not a requirement for every task');
  expect(system).toContain('first 10 enabled skills with IDs, names and descriptions');
  expect(system).toContain('operation search');
  expect(system).toContain('expectedVersion');
  expect(prompt({})).not.toContain('operation search');
  expect(prompt({})).not.toContain(mukaiSkillInstructions);
});

it('gives all roles the same shared prompt and adds main-bot instructions only for main bots', () => {
  const build = (isMain: boolean, delegated = false) =>
    buildBotSystemPrompt({
      bot: { id: 'bot', name: 'Ada', role: 'Assistant', isMain, createdBy: isMain ? null : 'main' },
      instructions: 'Help the user.',
      workspace: { id: 'workspace', name: 'Test workspace' },
      tools: { manage_bot: {} },
      delegated,
    });
  for (const isMain of [true, false])
    for (const delegated of [true, false]) {
      const system = build(isMain, delegated);
      expect(system.startsWith(v2 + '\n')).toBe(true);
      expect(system.includes(mukaiMainBotInstructions)).toBe(isMain);
      expect(system.includes("You are the workspace's main bot")).toBe(isMain);
    }
  expect(build(true)).toContain('Handle straightforward tasks directly');
  expect(build(true)).toContain('Create a specialist when the task warrants it');
  expect(build(true)).not.toContain('otherwise create a specialist and use it');
  expect(build(false)).toContain('You cannot create, update, or delete bots');
  expect(build(false)).toContain('direct them to the main bot');
  expect(build(false)).toContain('you may use send_message');
  expect(build(false, true)).toContain('intentionally unavailable to prevent delegation loops');
  expect(build(false, true)).toContain('automatically returned to the calling bot');
  expect(build(false, true)).not.toContain('you may use send_message');
  expect(build(true, true)).toContain('always has every manage_bot action');
});

it('keeps system instructions identical as the clock advances', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-15T01:00:00Z'));
    const first = prompt({ terminal: {} });
    vi.advanceTimersByTime(60000);
    expect(prompt({ terminal: {} })).toBe(first);
    expect(first).not.toMatch(/Current UTC time:|Runtime UTC now:/);
  } finally {
    vi.useRealTimers();
  }
});

it('builds explicit runtime snapshots with fresh time and cleared notices', () => {
  const state = {
    now: '2026-10-15T01:00:00Z',
    pursuits: [{ name: 'Ship Mukai' }],
    previousOperations: true,
  };
  const active = buildBotRuntimeContext({
    ...state,
    notice: 'Resume saved work.',
    progressNotice: 'Reassess.',
    pausedReason: 'Step limit reached.',
  });
  expect(active).toContain('[Mukai runtime context]');
  expect(active).toContain('Runtime UTC now: ' + state.now);
  expect(active).toContain('["Ship Mukai"]');
  expect(active).toContain('previous attempt performed operations');
  expect(active).toContain('Runtime notice: Resume saved work.');
  expect(active).toContain('Tools are now disabled');
  const cleared = buildBotRuntimeContext({ ...state, now: '2026-10-15T01:01:00Z' });
  expect(cleared).toContain('Runtime UTC now: 2026-10-15T01:01:00Z');
  expect(cleared).toContain('Runtime notices: none.');
  expect(cleared).not.toContain('Reassess.');
  expect(cleared).not.toContain('Tools are now disabled');
});
