import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NavigationRail } from './NavigationRail';
import type { AIActivity } from '../../../../shared/aiActivity';

const activity = vi.hoisted(() => ({ limit: 4, running: [], queued: [] }) as AIActivity);
vi.mock('../../services/aiActivityStore', () => ({ useAIActivity: () => activity }));

function render(props: Partial<ComponentProps<typeof NavigationRail>>) {
  return renderToStaticMarkup(
    createElement(NavigationRail, {
      onNavigate: () => {},
      onSettings: () => {},
      onCreate: () => {},
      ...props,
    }),
  );
}

function renderLinks(props: Partial<ComponentProps<typeof NavigationRail>>) {
  return [...render(props).matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attributes]) => /class="rail-link(?:\s|")/.test(attributes))
    .map(([, attributes, content]) => ({
      label: content.replace(/<[^>]*>/g, ''),
      disabled: /\bdisabled=""/.test(attributes),
      current: /aria-current="page"/.test(attributes),
    }));
}

describe('sidebar navigation', () => {
  it('shows all tabs disabled before the first workspace is created', () => {
    const links = renderLinks({ disabled: true, hasBots: false, section: 'bots' });
    expect(links).toEqual(
      ['Bots', 'Updates', 'Pursuits', 'Spaces', 'Tools', 'Telegram'].map((label) => ({
        label,
        disabled: true,
        current: false,
      })),
    );
  });

  it('allows Bots and Telegram before adding a bot and hides empty Updates', () => {
    expect(renderLinks({ hasBots: false, section: 'bots' })).toEqual([
      { label: 'Bots', disabled: false, current: true },
      { label: 'Pursuits', disabled: true, current: false },
      { label: 'Spaces', disabled: true, current: false },
      { label: 'Tools', disabled: true, current: false },
      { label: 'Telegram', disabled: false, current: false },
    ]);
  });

  it('unlocks tabs with a bot, shows available Updates, and marks the current tab', () => {
    const links = renderLinks({ hasBots: true, notificationCount: 1, section: 'telegram' });
    expect(links).toEqual(
      ['Bots', 'Updates', 'Pursuits', 'Spaces', 'Tools', 'Telegram'].map((label) => ({
        label,
        disabled: false,
        current: label === 'Telegram',
      })),
    );
  });

  it('marks Updates active when viewing the bot inbox', () => {
    expect(renderLinks({ notificationCount: 1, section: 'notifications' })).toContainEqual({
      label: 'Updates',
      disabled: false,
      current: true,
    });
  });

  it('swaps the Pursuits icon only while a run is active in the current workspace', () => {
    const run = {
      id: 'run',
      kind: 'pursuit' as const,
      workspaceId: 'current',
      workspaceName: 'Current',
      queuedAt: '2026-11-04T00:00:00Z',
    };
    const props = { workspaceId: run.workspaceId, section: 'bots' } as const;
    activity.pursuitQueued = [run];
    expect(render(props)).toContain('lucide-target');

    activity.pursuitQueued = [];
    activity.pursuitRunning = [run];
    const running = render(props);
    expect(running).toMatch(/lucide-loader-circle[^"]* is-spinning/);
    expect(running).toContain('aria-description="Pursuit running"');
    expect(running).not.toContain('lucide-target');
    expect(render({ ...props, workspaceId: 'other' })).toContain('lucide-target');

    activity.pursuitRunning = [];
    expect(render(props)).toContain('lucide-target');
  });

  it('shows Failed only with global failures, even when the current workspace has no bots', () => {
    expect(renderLinks({ failureCount: 0 }).some((link) => link.label.endsWith('Failed'))).toBe(
      false,
    );
    expect(renderLinks({ failureCount: 2, hasBots: false, section: 'failed' })).toContainEqual({
      label: '2Failed',
      disabled: false,
      current: true,
    });
  });
});
