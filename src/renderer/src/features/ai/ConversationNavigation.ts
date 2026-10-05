import { createContext } from 'react';

export const ConversationNavigation = createContext<((conversationId: string) => void) | undefined>(
  undefined,
);
