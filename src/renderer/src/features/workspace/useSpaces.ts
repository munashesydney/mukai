import { useCallback, useEffect, useState } from 'react';
import type { Conversation } from '../../../../shared/conversations';
import { conversationService } from '../../services/conversationService';
import { errorText } from '../../utils/errors';
import { loadWorkspace, workspaceStorageKey } from './workspaceStorage';

export function useSpaces(workspaceId: string) {
  const [spaces, setSpaces] = useState<Conversation[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [legacy] = useState(() => {
    const key =
      workspaceId === 'default' ? workspaceStorageKey : `${workspaceStorageKey}.${workspaceId}`;
    try {
      return localStorage.getItem(key)
        ? loadWorkspace(undefined, key, workspaceId !== 'default')
        : null;
    } catch {
      return null;
    }
  });
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const values = await conversationService.import(
        workspaceId,
        (legacy?.spaces || []).map((space) => ({
          ...space,
          messages: (legacy!.messages[space.id] || []).map((message) => ({
            id: message.id,
            text:
              message.text +
              (message.attachment
                ? `\n\nShared file: ${message.attachment} (legacy filename preview)`
                : ''),
            author: message.author,
            saved: legacy!.bookmarks.includes(message.id),
          })),
        })),
      );
      setSpaces(values);
      setError('');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, legacy]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function create(name: string, description: string, botIds: string[]) {
    const space = await conversationService.create(workspaceId, { name, description, botIds });
    setSpaces((previous) => [...previous, space]);
    return space;
  }
  return { spaces, error, loading, refresh, create };
}
