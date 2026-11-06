import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '../../../../shared/ai';
import type { TrajectoryMessageStats } from '../../../../shared/trajectory';
import { startPoll } from '../../services/poll';
import { trajectoryService } from '../../services/trajectoryService';

export function useChatStats(
  conversationId: string,
  loading: boolean,
  busy: boolean,
  latest?: ChatMessage,
) {
  const [records, setRecords] = useState<TrajectoryMessageStats[]>([]);
  const messageId = latest?.id;
  const status = latest?.status;
  useEffect(() => {
    if (loading || !messageId) return;
    let current = true;
    const read = async () => {
      try {
        const data = await trajectoryService.stats(conversationId);
        if (current) setRecords(data);
      } catch {
        // Context accounting from chat history remains available independently.
      }
    };
    const poll = busy ? startPoll(read, { interval: 1000 }) : undefined;
    if (!poll) void read();
    return () => {
      current = false;
      poll?.stop();
    };
  }, [conversationId, loading, busy, messageId, status]);
  return useMemo(() => new Map(records.map((record) => [record.messageId, record])), [records]);
}
