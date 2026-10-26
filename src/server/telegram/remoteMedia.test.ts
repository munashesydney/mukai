import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { downloadTelegramMedia, publicMediaAddress, publicMediaUrl } from './remoteMedia';
import { telegramFileLimit } from './media';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
const responses: {
  status?: number;
  headers?: Record<string, string | undefined>;
  chunks?: Buffer[];
}[] = [];
const opened: Readable[] = [];
const signal = () => AbortSignal.timeout(2000);
const lookupMock = vi.mocked(
  lookup as (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>,
);
beforeEach(() => {
  vi.resetAllMocks();
  responses.length = 0;
  opened.length = 0;
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  vi.mocked(request).mockImplementation((...args: unknown[]) => {
    const url = args[0] as URL;
    const options = args[1] as RequestOptions;
    const callback = args[2] as (response: IncomingMessage) => void;
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.end = (() => {
      options.lookup!(url.hostname, { all: true }, (error, addresses) => {
        if (error) {
          outgoing.emit('error', error);
          return;
        }
        expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
        const next = responses.shift() || {};
        const response = Object.assign(Readable.from(next.chunks || [Buffer.from('ID3audio')]), {
          statusCode: next.status || 200,
          headers: next.headers || {},
        }) as IncomingMessage;
        opened.push(response);
        callback(response);
      });
      return outgoing;
    }) as ClientRequest['end'];
    return outgoing;
  });
});

describe('Public Telegram media downloads', () => {
  it.each([
    'http://127.0.0.1/photo.png',
    'http://2130706433/photo.png',
    'http://0x7f000001/photo.png',
    'http://10.0.0.1/photo.png',
    'http://169.254.169.254/photo.png',
    'http://[::1]/photo.png',
    'http://[::ffff:127.0.0.1]/photo.png',
    'http://[fc00::1]/photo.png',
    'http://localhost./photo.png',
    'https://service.internal/photo.png',
    'https://user:secret@example.com/photo.png',
    'file:///private/photo.png',
  ])('rejects %s before making a request', async (href) => {
    await expect(downloadTelegramMedia(href, signal())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('permits public IPs and DNS names without embedded credentials', () => {
    expect(publicMediaUrl('https://example.com/photo.png').href).toBe(
      'https://example.com/photo.png',
    );
    expect(publicMediaAddress('8.8.8.8')).toBe(true);
    expect(publicMediaAddress('2606:4700:4700::1111')).toBe(true);
    expect(publicMediaAddress('::ffff:10.0.0.1')).toBe(false);
  });
  it('pins DNS to checked public addresses and detects media from its bytes', async () => {
    const result = await downloadTelegramMedia('https://example.com/song.mp3', signal());
    expect(result.name).toBe('song.mp3');
    expect(result.bytes).toEqual(Buffer.from('ID3audio'));
    expect(result.mediaType).toBe('audio/mpeg');
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
    expect(opened[0].destroyed).toBe(true);
  });
  it('rejects a hostname resolving to any private address', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(downloadTelegramMedia('https://example.com/song.mp3', signal())).rejects.toThrow(
      'Private',
    );
    expect(opened).toHaveLength(0);
  });
  it('checks redirect destinations before opening another connection', async () => {
    responses.push({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });
    await expect(downloadTelegramMedia('https://example.com/song.mp3', signal())).rejects.toThrow(
      'public',
    );
    expect(request).toHaveBeenCalledOnce();
    expect(opened[0].destroyed).toBe(true);
  });
  it('follows a bounded public redirect and closes both responses', async () => {
    responses.push({ status: 302, headers: { location: '/final.mp3' } });
    const result = await downloadTelegramMedia('https://example.com/song.mp3', signal());
    expect(result.name).toBe('final.mp3');
    expect(request).toHaveBeenCalledTimes(2);
    expect(opened.every((response) => response.destroyed)).toBe(true);
  });
  it.each([
    { headers: { 'content-length': String(telegramFileLimit + 1) } },
    { chunks: [Buffer.alloc(telegramFileLimit), Buffer.from('overflow')] },
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
    { chunks: [Buffer.alloc(0)] },
  ])('rejects oversized, HTML and empty responses and closes the download', async (response) => {
    responses.push(response);
    await expect(downloadTelegramMedia('https://example.com/song.mp3', signal())).rejects.toThrow();
    expect(opened[0].destroyed).toBe(true);
  });
});
