import { randomBytes } from 'node:crypto';
import { ApiError } from '../config';
import type { RouteEnvironmentLease } from '../../shared/routeAccess';

/** Ephemeral credentials accepted exclusively by custom-route dispatch. */
export class RouteCredentials {
  private closed = false;
  private leases = new Map<
    string,
    { workspaceId: string; expires: number; active?: () => Promise<boolean>; release: () => void }
  >();
  constructor(private track: (token: string) => () => void) {}
  issue(
    workspaceId: string,
    url: string,
    lifetimeMs: number,
    active?: () => Promise<boolean>,
  ): RouteEnvironmentLease {
    if (this.closed) throw new ApiError(503, 'Route access is shutting down.');
    this.prune();
    if (this.leases.size >= 10000) throw new ApiError(429, 'Too many active route credentials.');
    const token = 'mukai_routes_' + randomBytes(32).toString('base64url');
    const untrack = this.track(token);
    let released = false;
    const timer = setTimeout(() => release(), lifetimeMs);
    timer.unref();
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this.leases.delete(token);
      untrack();
    };
    this.leases.set(token, { workspaceId, expires: Date.now() + lifetimeMs, active, release });
    return { env: { MUKAI_ROUTES_URL: url, MUKAI_ROUTES_TOKEN: token }, release };
  }
  private prune() {
    for (const lease of this.leases.values()) if (lease.expires <= Date.now()) lease.release();
  }
  async authorized(token: string, workspaceId: string) {
    const lease = this.leases.get(token);
    if (!lease || lease.workspaceId !== workspaceId) return false;
    if (lease.expires <= Date.now()) {
      lease.release();
      return false;
    }
    if (lease.active) {
      try {
        if (await lease.active())
          return this.leases.get(token) === lease && lease.expires > Date.now();
      } catch {
        /* Fail closed when a computer disappears. */
      }
      lease.release();
      return false;
    }
    return true;
  }
  stopWorkspace(workspaceId: string) {
    for (const lease of this.leases.values())
      if (lease.workspaceId === workspaceId) lease.release();
  }
  close() {
    this.closed = true;
    for (const lease of this.leases.values()) lease.release();
  }
}
