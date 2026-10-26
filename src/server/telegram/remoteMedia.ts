import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { fileMetadata } from '../services/fileMetadata';
import { telegramFileLimit } from './media';
import type { TelegramMediaFile } from './types';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
export function publicMediaAddress(address: string) {
  const version = isIP(address);
  return version === 4
    ? !blocked.check(address, 'ipv4')
    : version === 6 && publicV6.check(address, 'ipv6');
}
export function publicMediaUrl(href: string) {
  const url = new URL(href);
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (!host.includes('.') && !isIP(host)) ||
    /(^|\.)(localhost|local|internal)$/.test(host) ||
    (isIP(host) && !publicMediaAddress(host))
  )
    throw new Error('Media requires a public HTTP(S) URL.');
  return url;
}

/** Anonymous downloads only. DNS is checked inside the socket lookup, including every redirect. */
export async function downloadTelegramMedia(
  href: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<TelegramMediaFile> {
  const url = publicMediaUrl(href);
  signal.throwIfAborted();
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        signal,
        agent: false,
        headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
        // Returning only the validated address pins the connection and prevents DNS rebinding.
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true, verbatim: true }).then(
            (addresses) => {
              if (
                !addresses.length ||
                addresses.some((item) => !publicMediaAddress(item.address))
              ) {
                callback(new Error('Private media addresses are blocked.'), '', 4);
                return;
              }
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0].address, addresses[0].family);
            },
            (error: Error) => callback(error, '', 4),
          );
        },
      },
      resolve,
    );
    request.on('error', reject);
    request.end();
  });
  try {
    if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
      if (redirects >= 3 || !response.headers.location)
        throw new Error('Too many media redirects.');
      response.destroy();
      return await downloadTelegramMedia(
        new URL(response.headers.location, url).href,
        signal,
        redirects + 1,
      );
    }
    if (response.statusCode !== 200) throw new Error('The media URL is unavailable.');
    if (/^text\/html\b/i.test(response.headers['content-type'] || ''))
      throw new Error('The media URL returned a web page.');
    if (Number(response.headers['content-length']) > telegramFileLimit)
      throw new Error('Media exceeds the Telegram file limit.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > telegramFileLimit) throw new Error('Media exceeds the Telegram file limit.');
      chunks.push(bytes);
    }
    if (!size) throw new Error('The media file is empty.');
    const bytes = Buffer.concat(chunks);
    const name = decodeURIComponent(url.pathname.split('/').at(-1) || 'media');
    return { name, bytes, ...fileMetadata(bytes.subarray(0, 4096), name, size) };
  } finally {
    response.destroy();
  }
}
