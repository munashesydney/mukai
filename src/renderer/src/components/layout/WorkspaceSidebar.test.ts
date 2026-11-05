import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIActivity, AIWork } from '../../../../shared/aiActivity';
import type { Workspace } from '../../../../shared/ai';
import type { Conversation } from '../../../../shared/conversations';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { runningWorkspaceIds } from '../../features/workspace/workspaceActivity';

const state = vi.hoisted(() => ({
  activity: { limit: 4, running: [], queued: [] } as AIActivity,
  busy: false,
}));
vi.mock('../../services/aiActivityStore', () => ({ useAIActivity: () => state.activity }));
vi.mock('../../features/ai/chatStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/ai/chatStore')>()),
  useConversationsBusy: () => state.busy,
}));
// Expose the menu entries in SSR without changing its production behavior.
vi.mock('../ui/PopupMenu', () => ({
  PopupMenu: ({
    trigger,
    children,
  }: {
    trigger: ReactNode;
    children: (close: () => void) => ReactNode;
  }) =>
    createElement(
      'div',
      null,
      createElement('button', null, trigger),
      children(() => {}),
    ),
}));

const work = (workspaceId?: string, kind: AIWork['kind'] = 'chat'): AIWork => ({
  id: 'run',
  kind,
  workspaceId,
  workspaceName: '',
  queuedAt: '2026-11-04T00:00:00Z',
});
const workspaces: Workspace[] = ['Current', 'Other', 'Idle'].map((name) => ({
  id: name.toLowerCase(),
  name,
  folder: null,
  createdAt: '2026-11-04T00:00:00Z',
}));
const chat = (workspaceId: string, isWorking = false): Conversation => ({
  id: 'chat',
  workspaceId,
  isWorking,
  kind: 'private',
  name: 'Chat',
  description: '',
  botIds: ['bot'],
  ownerBotId: 'bot',
  createdAt: '2026-11-04T00:00:00Z',
  updatedAt: '2026-11-04T00:00:00Z',
});
function render(conversations: Conversation[] = []) {
  return renderToStaticMarkup(
    createElement(WorkspaceSidebar, {
      location: { section: 'pursuits', item: '' },
      spaces: [],
      pursuits: [],
      bots: [],
      botConversations: conversations,
      botPairConversations: [],
      botPairLoading: false,
      botPairError: '',
      collapsed: false,
      workspace: workspaces[0],
      workspaces,
      onSelect() {},
      onDialog() {},
      onSettings() {},
      onRefreshBotPairs() {},
      onCreateConversation: async () => {},
      onWorkspace() {},
      onCreateWorkspace() {},
    }),
  );
}
function row(html: string, name: string) {
  return html
    .match(/<button[^>]*role="menuitemradio"[\s\S]*?<\/button>/g)!
    .find((entry) => entry.includes(`<strong>${name}</strong>`))!;
}

beforeEach(() => {
  state.activity = { limit: 4, running: [], queued: [] };
  state.busy = false;
});
describe('Workspace picker activity', () => {
  it('includes running agents and pursuits in other workspaces without flagging queued or unscoped work', () => {
    expect(
      runningWorkspaceIds({
        limit: 4,
        running: [work('current'), work('current'), work()],
        workingWorkspaceIds: ['using-tools'],
        pursuitRunning: [work('other', 'pursuit')],
        queued: [work('idle')],
        pursuitQueued: [work('idle', 'pursuit')],
      }),
    ).toEqual(new Set(['current', 'other', 'using-tools']));
  });

  it('shows activity only at the end of busy menu rows, after the selection check', () => {
    state.activity.workingWorkspaceIds = ['current'];
    state.activity.pursuitRunning = [work('other', 'pursuit')];
    const html = render();
    expect(html.slice(0, html.indexOf('</button>'))).not.toContain('typing-dots');
    expect(row(html, 'Current')).toMatch(
      /lucide-check[\s\S]*Agents are working in Current[\s\S]*<\/span><\/span><\/button>$/,
    );
    expect(row(html, 'Other')).toMatch(
      /Agents are working in Other[\s\S]*<\/span><\/span><\/button>$/,
    );
    expect(row(html, 'Idle')).not.toContain('typing-dots');
    expect(row(html, 'Current')).toContain('aria-checked="true"');
    state.activity = { limit: 4, running: [], queued: [] };
    expect(render()).not.toContain('typing-dots');
  });

  it('includes live and saved conversation work only in its own workspace', () => {
    expect(row(render([chat('other', true)]), 'Current')).not.toContain('typing-dots');
    expect(row(render([chat('current', true)]), 'Current')).toContain('typing-dots');
    state.busy = true;
    expect(row(render([chat('current')]), 'Current')).toContain('typing-dots');
  });
});
