import { useState } from 'react';
import type { ChatMessage } from '../../../../shared/ai';

export function useWorkDisclosure(message: ChatMessage) {
  const attempt = `${message.id}:${message.startedAt || ''}`;
  const [choice, setChoice] = useState<{ attempt: string; expanded: boolean } | null>(null);
  return {
    workExpanded: choice?.attempt === attempt ? choice.expanded : message.status === 'streaming',
    onWorkExpandedChange: (expanded: boolean) => setChoice({ attempt, expanded }),
  };
}
