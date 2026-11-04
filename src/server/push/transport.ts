import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { publicMediaAddress, publicMediaUrl } from '../telegram/remoteMedia';
import { ApiError } from '../config';

export function relayOrigin(value: string) {
  try {
    const url = publicMediaUrl(value);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash)
      throw new Error();
    return url.origin;
  } catch {
    throw new ApiError(400, 'Push relay must be a public HTTPS origin.');
  }
}
export type PushSender = (
  origin: string,
  id: string,
  credential: string,
  payload: Record<string, string>,
) => Promise<number>;
export const sendPush: PushSender = (origin, id, credential, payload) =>
  new Promise((resolve, reject) => {
    const target = new URL(
      `/v1/devices/${encodeURIComponent(id)}/notifications`,
      relayOrigin(origin),
    );
    const body = JSON.stringify(payload);
    const call = request(
      target,
      {
        method: 'POST',
        agent: false,
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true, verbatim: true }).then(
            (addresses) => {
              if (
                !addresses.length ||
                addresses.some((entry) => !publicMediaAddress(entry.address))
              ) {
                callback(new Error('Private push relay addresses are blocked.'), '', 4);
              } else if (options.all) callback(null, addresses);
              else callback(null, addresses[0].address, addresses[0].family);
            },
            (error: Error) => callback(error, '', 4),
          );
        },
      },
      (response) => {
        // No redirects: the device capability must never reach another origin.
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 503));
        response.once('error', reject);
      },
    );
    call.once('error', reject);
    call.end(body);
  });
