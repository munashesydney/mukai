import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { NotificationsPage } from './NotificationsPage';

vi.mock('../../components/ui/Tooltip', () => ({
  Tooltip: ({ content, label }: { content: import('react').ReactNode; label: string }) =>
    createElement('aside', { 'aria-label': label }, content),
}));

it('labels the bot inbox Updates and explains how to reach software updates through the shared tooltip', () => {
  const html = renderToStaticMarkup(
    createElement(NotificationsPage, {
      workspaceId: 'workspace',
      inbox: {
        items: [],
        unread: 0,
        total: 0,
        loading: false,
        error: '',
        refresh: vi.fn(),
        loadMore: vi.fn(),
      },
      onOpen: vi.fn(),
      onGoToBots: vi.fn(),
      onOpenSoftwareUpdates: vi.fn(),
    }),
  );
  expect(html).toContain('<h1>Updates<span>0</span></h1>');
  expect(html).not.toContain('Messages');
  expect(html).toContain('aria-label="About bot updates"');
  expect(html).toContain('autonomous work and pursuits');
  expect(html).toContain('These are not software updates.');
  expect(html).toContain('Settings → Updates</button>');
});
