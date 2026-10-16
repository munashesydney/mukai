import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NavigationRail } from './NavigationRail';

function renderLinks(props: Partial<ComponentProps<typeof NavigationRail>>) {
  const html = renderToStaticMarkup(
    createElement(NavigationRail, {
      onNavigate: () => {},
      onSettings: () => {},
      onCreate: () => {},
      ...props,
    }),
  );
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
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
      ['Bots', 'Messages', 'Pursuits', 'Spaces', 'Tools', 'Telegram'].map((label) => ({
        label,
        disabled: true,
        current: false,
      })),
    );
  });

  it('allows Bots and Telegram before adding a bot and hides empty Messages', () => {
    expect(renderLinks({ hasBots: false, section: 'bots' })).toEqual([
      { label: 'Bots', disabled: false, current: true },
      { label: 'Pursuits', disabled: true, current: false },
      { label: 'Spaces', disabled: true, current: false },
      { label: 'Tools', disabled: true, current: false },
      { label: 'Telegram', disabled: false, current: false },
    ]);
  });

  it('unlocks tabs with a bot, shows available Messages, and marks the current tab', () => {
    const links = renderLinks({ hasBots: true, notificationCount: 1, section: 'telegram' });
    expect(links).toEqual(
      ['Bots', 'Messages', 'Pursuits', 'Spaces', 'Tools', 'Telegram'].map((label) => ({
        label,
        disabled: false,
        current: label === 'Telegram',
      })),
    );
  });
});
