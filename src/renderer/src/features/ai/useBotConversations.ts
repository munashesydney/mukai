import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Conversation } from '../../../../shared/conversations';
import { conversationService } from '../../services/conversationService';
import { errorText } from '../../utils/errors';
import { startPoll, type PollHandle } from '../../services/poll';

/**
 * One shared listing per workspace + kind.
 *
 * The sidebar and the activity drawer both want the same conversation list, and as
 * two independent hooks they each paid for it: two requests every three seconds, two
 * copies of the answer, two re-render passes. The listing lives here instead,
 * refcounted by whoever is looking at it, while components read a snapshot.
 */
interface Snapshot {
  conversations: Conversation[];
  loading: boolean;
  error: string;
}

interface Listing {
  key: string;
  workspaceId: string;
  kind: 'private' | 'bot';
  snapshot: Snapshot;
  refs: number;
  /** Bumped by local actions so an older in-flight response is not allowed to land. */
  revision: number;
  pending: boolean;
  poll?: PollHandle;
}

const EMPTY: Snapshot = { conversations: [], loading: true, error: '' };
const listings = new Map<string, Listing>();
const watched = new Map<string, Set<() => void>>();

const keyFor = (workspaceId: string, kind: string) => `${workspaceId}:${kind}`;

function notify(listing: Listing) {
  watched.get(listing.key)?.forEach((listener) => listener());
}

function replace(listing: Listing, value: Partial<Snapshot>) {
  const next = { ...listing.snapshot, ...value };
  if (
    next.conversations === listing.snapshot.conversations &&
    next.loading === listing.snapshot.loading &&
    next.error === listing.snapshot.error
  ) {
    return;
  }
  listing.snapshot = next;
  notify(listing);
}

/** Returns false only when the read completed and the list provably did not move. */
async function load(listing: Listing): Promise<boolean> {
  if (listing.pending) return true; // a read is already on its way: unknown, not unchanged
  listing.pending = true;
  const revision = listing.revision;
  try {
    const values = await (listing.kind === 'bot'
      ? conversationService.botChats(listing.workspaceId)
      : conversationService.privateChats(listing.workspaceId));
    if (revision !== listing.revision) return true;
    const previous = listing.snapshot.conversations;
    const unchanged =
      values.length === previous.length && JSON.stringify(values) === JSON.stringify(previous);
    if (!unchanged) replace(listing, { conversations: values, error: '' });
    else if (listing.snapshot.error) replace(listing, { error: '' });
    return !unchanged;
  } catch (caught) {
    replace(listing, { error: errorText(caught) });
    return true;
  } finally {
    listing.pending = false;
    if (listing.snapshot.loading) replace(listing, { loading: false });
  }
}

function acquire(workspaceId: string, kind: 'private' | 'bot'): Listing {
  const key = keyFor(workspaceId, kind);
  const existing = listings.get(key);
  if (existing) {
    existing.refs++;
    return existing;
  }
  const listing: Listing = {
    key,
    workspaceId,
    kind,
    snapshot: EMPTY,
    refs: 1,
    revision: 0,
    pending: false,
  };
  listings.set(key, listing);
  listing.poll = startPoll(() => load(listing), { interval: 3000, maxInterval: 10000 });
  return listing;
}

function release(listing: Listing) {
  listing.refs--;
  if (listing.refs > 0) return;
  listing.poll?.stop();
  listing.poll = undefined;
  if (listings.get(listing.key) === listing) listings.delete(listing.key);
}

/** Apply a local insertion now and make anything in flight lose to it. */
function insert(listing: Listing, value: Conversation) {
  listing.revision++;
  replace(listing, {
    conversations: [
      value,
      ...listing.snapshot.conversations.filter((item) => item.id !== value.id),
    ],
  });
}

export function useBotConversations(workspaceId: string, kind: 'private' | 'bot' = 'private') {
  const key = keyFor(workspaceId, kind);
  const subscribe = useCallback(
    (listener: () => void) => {
      let listeners = watched.get(key);
      if (!listeners) {
        listeners = new Set();
        watched.set(key, listeners);
      }
      listeners.add(listener);
      return () => {
        const current = watched.get(key);
        current?.delete(listener);
        if (current && !current.size) watched.delete(key);
      };
    },
    [key],
  );
  const getSnapshot = useCallback((): Snapshot => listings.get(key)?.snapshot ?? EMPTY, [key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const listing = acquire(workspaceId, kind);
    return () => release(listing);
  }, [workspaceId, kind]);

  const current = useCallback(() => listings.get(key), [key]);

  const create = useCallback(
    async (botId: string) => {
      const listing = current();
      if (listing) listing.revision++; // whatever is in flight is already stale
      const value = await conversationService.createPrivate(botId);
      if (listing) insert(listing, value);
      return value;
    },
    [current],
  );

  const include = useCallback(
    (value: Conversation) => {
      const listing = current();
      if (listing) insert(listing, value);
    },
    [current],
  );

  const refresh = useCallback(() => {
    const listing = current();
    if (!listing) return;
    listing.revision++;
    listing.poll?.refresh();
  }, [current]);

  return {
    conversations: snapshot.conversations,
    loading: snapshot.loading,
    error: snapshot.error,
    create,
    include,
    refresh,
  };
}
