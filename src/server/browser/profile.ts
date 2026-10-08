import { createHash } from 'node:crypto';

/** Profile identity belongs to a workspace; tab ownership remains conversation-specific. */
export function workspaceBrowserProfile(workspaceId: string) {
  return createHash('sha256').update(workspaceId).digest('hex');
}
