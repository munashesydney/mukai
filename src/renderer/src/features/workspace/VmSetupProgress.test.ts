import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VmSetupProgress } from './VmSetupProgress';

describe('VM setup notices', () => {
  it.each(['preparing', 'ready'] as const)(
    'keeps the software emulation notice visible while %s',
    (phase) => {
      const html = renderToStaticMarkup(
        createElement(VmSetupProgress, {
          setup: {
            available: phase === 'ready',
            phase,
            warning: 'This VM uses software emulation. Apps may run considerably slower.',
          },
          error: '',
          onRetry: () => {},
        }),
      );
      expect(html).toContain('Apps may run considerably slower.');
      if (phase === 'ready') expect(html).not.toContain('Retry setup');
    },
  );
  it('does not show a software warning for hardware accelerated setup', () => {
    const html = renderToStaticMarkup(
      createElement(VmSetupProgress, {
        setup: { available: true, phase: 'ready' },
        error: '',
        onRetry: () => {},
      }),
    );
    expect(html).not.toContain('software emulation');
  });
});
