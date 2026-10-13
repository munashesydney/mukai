import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../config';
import { jsonBody, send } from '../http/transport';

export function matches(value: string, expected: string) {
  const bytes = Buffer.from(value);
  const reference = Buffer.from(expected);
  return bytes.length === reference.length && timingSafeEqual(bytes, reference);
}

/** The API token stays on the server. Each server lifetime has its own browser credential. */
export class BrowserSession {
  readonly connectToken = randomBytes(32).toString('hex');
  private readonly credential = randomBytes(32).toString('hex');
  private expires = 0;
  private readonly cookieName: string;
  constructor(readonly instanceId: string) {
    this.cookieName = `mukai_${instanceId}`;
  }
  authenticated(request: IncomingMessage) {
    if (Date.now() >= this.expires) return false;
    const cookies = (request.headers.cookie || '').split(';').map((value) => value.trim());
    const values = cookies.filter((value) => value.startsWith(this.cookieName + '='));
    return (
      values.length === 1 && matches(values[0].slice(this.cookieName.length + 1), this.credential)
    );
  }
  async handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.method === 'POST') {
      const input = (await jsonBody(request, 1024)) as { token?: unknown };
      if (!input || typeof input.token !== 'string' || !matches(input.token, this.connectToken))
        throw new ApiError(401, 'Use the connection link printed by mukai serve.');
      this.expires = Date.now() + 24 * 60 * 60 * 1000;
      response.setHeader(
        'Set-Cookie',
        `${this.cookieName}=${this.credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      );
      send(response, { connected: true });
      return;
    }
    if (request.method !== 'GET') throw new ApiError(405, 'Method not allowed');
    if (!this.authenticated(request))
      throw new ApiError(401, 'Open the connection link printed by mukai serve.');
    send(response, { connected: true });
  }
}
