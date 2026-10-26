import { useState } from 'react';
import type { ChatMessage } from '../../../../shared/ai';

export function useWorkDisclosure(message: ChatMessage) {
  // Choices made while streaming expire at completion; finished work can be reopened.
  const attempt = `${message.id}:${message.startedAt || ''}:${message.status === 'streaming' ? 'streaming' : 'finished'}`;
  const [choice, setChoice] = useState<{ attempt: string; expanded: boolean } | null>(null);
  return {
    workExpanded: choice?.attempt === attempt ? choice.expanded : message.status === 'streaming',
    onWorkExpandedChange: (expanded: boolean) => setChoice({ attempt, expanded }),
  };
}
