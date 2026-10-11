import { expect, it } from 'vitest';
import { localServerUrl, serverUrls } from './chatActivity';
it('recognizes local server URLs, normalizes bind addresses, and deduplicates output', () => {
  expect(
    serverUrls(
      '\u001b[32mLocal: http://localhost:5173/\u001b[0m\nhttp://localhost:5173/\nListening http://0.0.0.0:3000/preview',
    ),
  ).toEqual(['http://localhost:5173/', 'http://localhost:3000/preview']);
  expect(
    serverUrls('https://example.com:3000/ http://localhost:99999/ javascript:alert(1)'),
  ).toEqual([]);
  expect(serverUrls('http://localhost:655350/ http://localhost:0/')).toEqual([]);
  expect(serverUrls('http://localhost:80/ https://localhost:443/')).toEqual([
    'http://localhost/',
    'https://localhost/',
  ]);
  expect(localServerUrl('http://localhost/')).toBe('http://localhost/');
  expect(localServerUrl('https://example.com:3000/')).toBeUndefined();
  expect(serverUrls('http://[::]:4321/ http://[::1]:8080/')).toEqual([
    'http://localhost:4321/',
    'http://[::1]:8080/',
  ]);
});
