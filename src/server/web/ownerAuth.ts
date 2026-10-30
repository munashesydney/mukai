import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from '../db/database';
import { ApiError } from '../config';
import { jsonBody, send } from '../http/transport';
import { z } from 'zod';
import { localBrowserRequest, guestGatewayBrowserRequest } from './origin';
import { ownerCredentialsSchema } from '../../shared/ownerAuth';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const cookie = (request: IncomingMessage, name: string) => {
  const values = (request.headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
};

/** Single owner; raw passwords and session credentials are never stored in SQLite. */
export class OwnerAuth {
  readonly setupCode = randomBytes(16).toString('hex');
  private setupExpires = Date.now() + 30 * 60_000;
  private proofs = new Map<string, number>();
  private attempts = new Map<string, { count: number; until: number }>();
  private hashing = 0;
  private readonly sessionName: string;
  private readonly proofName: string;
  private readonly dummySalt = randomBytes(16).toString('hex');
  constructor(private readonly store: Database) {
    const suffix = digest(store.dir).slice(0, 12);
    this.sessionName = 'mukai_owner_' + suffix;
    this.proofName = 'mukai_setup_' + suffix;
  }
  configured() {
    return Boolean(this.store.get('SELECT id FROM web_owner WHERE id=1'));
  }
  authenticated(request: IncomingMessage) {
    const token = cookie(request, this.sessionName);
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    return Boolean(
      this.store.get(
        'SELECT token_hash FROM web_sessions WHERE token_hash=? AND expires_at>?',
        digest(token),
        Date.now(),
      ),
    );
  }
  private verified(request: IncomingMessage) {
    return (this.proofs.get(digest(cookie(request, this.proofName))) || 0) > Date.now();
  }
  private limit(kind: string) {
    const now = Date.now();
    let counter = this.attempts.get(kind);
    if (!counter || counter.until <= now) {
      counter = { count: 0, until: now + 60_000 };
      this.attempts.set(kind, counter);
    }
    if (++counter.count > 10)
      throw new ApiError(429, 'Too many attempts. Wait a minute and try again.');
  }
  private hash(password: string, salt: string): Promise<string> {
    if (this.hashing >= 2)
      throw new ApiError(429, 'Mukai is processing another login. Try again shortly.');
    this.hashing++;
    return new Promise((resolve, reject) => {
      scrypt(
        password,
        Buffer.from(salt, 'hex'),
        64,
        { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
        (error, key) => {
          this.hashing--;
          if (error) reject(error);
          else resolve(key.toString('hex'));
        },
      );
    });
  }
  private setCookie(
    request: IncomingMessage,
    response: ServerResponse,
    name: string,
    token: string,
    age: number,
  ) {
    // Browsers supply their real origin even when TLS terminates at a user-managed proxy.
    const secure = request.headers.origin?.startsWith('https://') ? '; Secure' : '';
    response.setHeader(
      'Set-Cookie',
      `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`,
    );
  }
  private signIn(request: IncomingMessage, response: ServerResponse) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.store.run('DELETE FROM web_sessions WHERE expires_at<=?', now);
    const previous = cookie(request, this.sessionName);
    if (previous) this.store.run('DELETE FROM web_sessions WHERE token_hash=?', digest(previous));
    this.store.run('INSERT INTO web_sessions VALUES(?,?)', digest(token), now + 7 * 86400_000);
    this.setCookie(request, response, this.sessionName, token, 7 * 86400);
    send(response, { authenticated: true });
  }
  async handle(action: string, request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (action === 'status' && request.method === 'GET') {
      send(response, {
        configured: this.configured(),
        authenticated: this.authenticated(request),
        verified: !this.configured() && this.verified(request),
      });
      return;
    }
    if (!['verify', 'setup', 'login', 'logout'].includes(action))
      throw new ApiError(404, 'Not found');
    if (request.method !== 'POST') throw new ApiError(405, 'Method not allowed');
    // Cookie-changing endpoints require a same-origin browser request, checked by the web boundary.
    if (!request.headers.origin) throw new ApiError(403, 'A browser origin is required.');
    if (
      !localBrowserRequest(request) &&
      !guestGatewayBrowserRequest(request) &&
      !request.headers.origin.startsWith('https://')
    )
      throw new ApiError(403, 'Use an HTTPS connection to sign in remotely.');
    if (action === 'logout') {
      this.store.run(
        'DELETE FROM web_sessions WHERE token_hash=?',
        digest(cookie(request, this.sessionName)),
      );
      this.setCookie(request, response, this.sessionName, '', 0);
      send(response, { authenticated: false });
      return;
    }
    this.limit(action);
    if (action === 'verify') {
      if (this.configured())
        throw new ApiError(409, 'An owner login already exists. Sign in instead.');
      const input = z
        .object({ code: z.string().max(128) })
        .strict()
        .parse(await jsonBody(request, 2048));
      const code = input.code.replace(/[\s-]/g, '').toLowerCase();
      if (Date.now() >= this.setupExpires || !equal(code, this.setupCode))
        throw new ApiError(
          401,
          'The setup code is incorrect or expired. Check the terminal where you started Mukai.',
        );
      for (const [key, expiry] of this.proofs) if (expiry <= Date.now()) this.proofs.delete(key);
      if (this.proofs.size >= 20)
        throw new ApiError(429, 'Too many setup sessions. Try again shortly.');
      const proof = randomBytes(32).toString('hex');
      this.proofs.set(digest(proof), Date.now() + 5 * 60_000);
      this.setCookie(request, response, this.proofName, proof, 300);
      send(response, { verified: true });
      return;
    }
    if (action === 'setup') {
      if (this.configured())
        throw new ApiError(409, 'An owner login already exists. Sign in instead.');
      if (!this.verified(request))
        throw new ApiError(401, 'Verify your setup code again before creating your login.');
      const parsed = ownerCredentialsSchema.safeParse(await jsonBody(request, 4096));
      if (!parsed.success)
        throw new ApiError(
          400,
          parsed.error.issues[0].code === 'unrecognized_keys'
            ? 'Only username and password are accepted.'
            : parsed.error.issues[0].message,
        );
      const input = parsed.data;
      const salt = randomBytes(16).toString('hex');
      const hash = await this.hash(input.password, salt);
      // Another verified browser can finish while password hashing is in flight.
      const inserted = this.store.run(
        'INSERT OR IGNORE INTO web_owner VALUES(1,?,?,?,?)',
        input.username,
        hash,
        salt,
        Date.now(),
      );
      if (!inserted.changes)
        throw new ApiError(409, 'An owner login already exists. Sign in instead.');
      this.proofs.clear();
      this.setupExpires = 0;
      this.signIn(request, response);
      return;
    }
    const input = z
      .object({ username: z.string().max(254), password: z.string().max(256) })
      .strict()
      .parse(await jsonBody(request, 4096));
    const owner = this.store.get('SELECT username,password_hash,salt FROM web_owner WHERE id=1');
    const hash = await this.hash(input.password, String(owner?.salt || this.dummySalt));
    if (
      !owner ||
      !equal(hash, String(owner.password_hash)) ||
      !equal(input.username.trim(), String(owner.username))
    )
      throw new ApiError(401, 'The username or password is incorrect.');
    this.signIn(request, response);
  }
}
