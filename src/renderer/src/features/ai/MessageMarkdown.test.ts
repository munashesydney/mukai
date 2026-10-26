import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MessageMarkdown } from './MessageMarkdown';
import { ResponseReferenceContext } from './responseReferenceContext';
const render = (text: string, streaming = false, imageGallery = false) =>
  renderToStaticMarkup(
    createElement(
      ResponseReferenceContext.Provider,
      { value: 'conversation' },
      createElement(MessageMarkdown, { text, streaming, imageGallery }),
    ),
  );
const json = JSON.stringify({
  version: 1,
  type: 'bar',
  title: 'Quarterly revenue',
  xKey: 'month',
  series: [{ key: 'revenue' }],
  data: [
    { month: 'Jan', revenue: 9 },
    { month: 'Feb', revenue: -2 },
  ],
});
it('turns explicit file links into previews while preserving web links and ordinary code', () => {
  const html = render(
    '[Report](mukai://artifact/report-id) [Source](./notes.md#L2) [Website](https://example.com) `src/app.ts`',
  );
  expect(html.match(/response-file-link/g)).toHaveLength(2);
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain('<code>src/app.ts</code>');
});
it('supports inline internal images without auto-fetching remote image URLs', () => {
  const html = render(
    '![Render](mukai://attachment/image-id) ![External](https://example.com/image.png)',
  );
  expect(html).toContain('response-reference-image');
  expect(html).not.toContain('src="https://example.com');
  expect(render('[bad](javascript:alert%281%29)')).not.toContain('javascript:');
});
it('renders complete charts as SVG with accessible data and keeps incomplete blocks inert', () => {
  const html = render('```mukai-chart\n' + json + '\n```');
  expect(html).toContain('<svg');
  expect(html).toContain('Quarterly revenue');
  expect(html).toContain('View data table');
  expect(html).not.toContain('<pre><section');
  const partial = render('```mukai-chart\n' + json, true);
  expect(partial).toContain('Reviewing chart');
  expect(partial).toContain('is-spinning');
  expect(partial).toContain('role="status"');
  expect(partial).not.toContain('response-chart-plot');
  expect(render('```mukai-chart\n' + json)).not.toContain('is-spinning');
  expect(render('```mukai-chart\n{"version":1,"type":"execute"}\n```')).toContain('invalid format');
});
it('puts a single image below the reply and keeps its inline reference', () => {
  const html = render('Look at ![Chair](renders/chair.png).\n\nThe final paragraph.', false, true);
  expect(html).toContain('response-gallery-link');
  expect(html).toContain('aria-label="Images in this reply"');
  expect(html.indexOf('response-image-gallery')).toBeGreaterThan(
    html.indexOf('The final paragraph.'),
  );
  expect(html).not.toContain('aria-label="Next image"');
  expect(html).toContain('aria-label="Preview Chair"');
});
it('renders only explicitly referenced images in a deduplicated carousel', () => {
  const html = render(
    '[First](mukai://artifact/one) ![First image](mukai://artifact/one) ![Second](mukai://attachment/two) ![Repeated](mukai://attachment/two) [Notes](notes.md)',
    false,
    true,
  );
  expect(html.match(/class="response-gallery-slide"/g)).toHaveLength(2);
  expect(html.match(/response-gallery-link/g)).toHaveLength(4);
  expect(html).toContain('aria-roledescription="carousel"');
  expect(html).toContain('aria-label="Next image"');
  expect(html).toContain('1 / 2');
  expect(html).not.toContain('<img');
});
