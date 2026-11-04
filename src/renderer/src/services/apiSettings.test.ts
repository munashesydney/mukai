import { afterEach, expect, it, vi } from 'vitest';
import { apiBaseUrl } from './http';

afterEach(() => vi.unstubAllGlobals());

it('uses the served address for browser connection details without fetching the token', async () => {
  vi.stubGlobal('window', { location: { href: 'https://mukai.example/' } });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await apiBaseUrl()).toBe('https://mukai.example');
  expect(fetch).not.toHaveBeenCalled();
});

it('uses the connected desktop server address and removes the API suffix', async () => {
  const getApiConnection = vi.fn(async () => ({
    url: 'http://127.0.0.1:64111/api',
    token: 'fixture',
  }));
  vi.stubGlobal('window', {
    location: { href: 'file:///mukai/out/renderer/index.html' },
    mukai: { getApiConnection },
  });
  expect(await apiBaseUrl()).toBe('http://127.0.0.1:64111');
  expect(getApiConnection).toHaveBeenCalledOnce();
});
