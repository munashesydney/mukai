import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, privateSecret } from '../config';
import type { Database } from '../db/database';
import type { RouteEnvironment } from '../../shared/routeAccess';

/** Stable workspace credentials accepted exclusively by custom-route dispatch. */
export class RouteCredentials {
  private closed = false;
  private stopped = new Set<string>();
  private tokens = new Map<string, string>();
  private key: Buffer;
  constructor(
    private db: Database,
    private track: (token: string) => void,
  ) {
    this.key = privateSecret(db.dir, 'credentials.key', 32);
    // Mask credentials inherited by existing services even before the first new launch.
    for (const row of db.all('SELECT id FROM workspaces WHERE deleting=0'))
      this.token(String(row.id));
  }
  private token(workspaceId: string) {
    let token = this.tokens.get(workspaceId);
    if (!token) {
      // Domain separation keeps this independent of other uses of the encryption key.
      token =
        'mukai_routes_' +
        createHmac('sha256', this.key)
          .update('mukai:custom-route-access:v1\0')
          .update(workspaceId)
          .digest('base64url');
      this.track(token);
      this.tokens.set(workspaceId, token);
    }
    return token;
  }
  private available(workspaceId: string) {
    return (
      !this.closed &&
      !this.stopped.has(workspaceId) &&
      !!this.db.get('SELECT id FROM workspaces WHERE id=? AND deleting=0', workspaceId)
    );
  }
  issue(workspaceId: string, url: string): RouteEnvironment {
    if (this.closed) throw new ApiError(503, 'Route access is shutting down.');
    if (!this.available(workspaceId)) throw new ApiError(404, 'Workspace is unavailable.');
    return { env: { MUKAI_ROUTES_URL: url, MUKAI_ROUTES_TOKEN: this.token(workspaceId) } };
  }
  authorized(token: string, workspaceId: string) {
    if (!this.available(workspaceId)) return false;
    const expected = Buffer.from(this.token(workspaceId));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
  stopWorkspace(workspaceId: string) {
    this.stopped.add(workspaceId);
    // Keep masking credentials from earlier output even after access is removed.
    this.tokens.delete(workspaceId);
  }
  close() {
    this.closed = true;
    this.tokens.clear();
  }
}
