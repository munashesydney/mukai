import { expect, it } from 'vitest';
import { responseImageKey, responseImages } from './responseImages';

it('collects explicit images and image file links in reply order', () => {
  expect(
    responseImages(
      '![Upload](mukai://attachment/upload) [Render](renders/chair.PNG) [report](report.pdf) ![Shot](mukai://artifact/shot)',
    ),
  ).toEqual([
    { key: 'attachment:upload', href: 'mukai://attachment/upload', label: 'Upload' },
    { key: 'file:renders/chair.PNG', href: 'renders/chair.PNG', label: 'Render' },
    { key: 'artifact:shot', href: 'mukai://artifact/shot', label: 'Shot' },
  ]);
});
it('deduplicates repeated destinations and routes regular links to embedded image IDs', () => {
  const images = responseImages(
    '[See it](mukai://artifact/shot) ![Shot](mukai://artifact/shot) ![Again](mukai://artifact/shot#L2) ![A](./renders/a.png) [B](renders/a.png)',
  );
  expect(images.map((image) => image.key)).toEqual(['artifact:shot', 'file:renders/a.png']);
  expect(responseImageKey('mukai://file/renders%2Fa.png')).toBe(
    responseImageKey('./renders/a.png'),
  );
});
it('supports Markdown reference definitions and formatted link labels', () => {
  expect(
    responseImages(
      '![Upload][shot]\n\n[**Image.png**][file]\n\n[shot]: mukai://attachment/upload\n[file]: mukai://artifact/file',
    ),
  ).toEqual([
    { key: 'attachment:upload', href: 'mukai://attachment/upload', label: 'Upload' },
    { key: 'artifact:file', href: 'mukai://artifact/file', label: 'Image.png' },
  ]);
});
it('ignores code, remote images, unsafe destinations, and incomplete streaming references', () => {
  expect(
    responseImages(
      '`![code](fake.png)`\n\n```md\n![example](example.png)\n```\n\n![remote](https://example.com/image.png) ![bad](javascript:alert) ![broken](mukai://artifact/%00) ![unfinished](pending.png',
    ),
  ).toEqual([]);
});
it('does not classify text files as images from their link label', () => {
  expect(responseImages('[image.png](notes.md) [Open](mukai://artifact/unknown)')).toEqual([]);
});
