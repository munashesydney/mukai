import { useState } from 'react';
import type { ChatMessage } from '../../../../shared/ai';

export function useWorkDisclosure(message: ChatMessage) {
  const attempt = `${message.id}:${message.startedAt || ''}`;
  const [openAttempt, setOpenAttempt] = useState<string | null>(null);
  return {
    workExpanded: openAttempt === attempt,
    onWorkExpandedChange: (expanded: boolean) => setOpenAttempt(expanded ? attempt : null),
  };
}
