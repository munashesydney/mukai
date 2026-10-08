import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../../../shared/conversations';
import { conversationService } from '../../services/conversationService';
import { errorText } from '../../utils/errors';

export function useBotConversations(workspaceId: string, kind: 'private' | 'bot' = 'private') {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const revision = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const version = revision.current;
      try {
        const values = await (kind === 'bot'
          ? conversationService.botChats(workspaceId)
          : conversationService.privateChats(workspaceId));
        if (alive && version === revision.current) {
          setConversations(values);
          setError('');
        }
      } catch (caught) {
        if (alive) setError(errorText(caught));
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [workspaceId, refreshVersion, kind]);
  const create = useCallback(async (botId: string) => {
    revision.current++;
    const value = await conversationService.createPrivate(botId);
    revision.current++;
    setConversations((previous) => [value, ...previous.filter((item) => item.id !== value.id)]);
    return value;
  }, []);
  return {
    conversations,
    loading,
    error,
    create,
    include: (value: Conversation) => {
      revision.current++;
      setConversations((previous) => [value, ...previous.filter((item) => item.id !== value.id)]);
    },
    refresh: () => setRefreshVersion((value) => value + 1),
  };
}
