import type { ChatServerOutput } from '../../../shared/chatActivity';
import type { BrowserSession } from '../../../shared/runtime';
import { api } from './http';
import type { TerminalSnapshot } from '../../../shared/terminal';

export const chatActivityService = {
  terminal: (conversationId: string, sessionId: string) =>
    api<TerminalSnapshot>(
      `/conversations/${encodeURIComponent(conversationId)}/terminal?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  outputs: (conversationId: string) =>
    api<ChatServerOutput[]>(`/conversations/${encodeURIComponent(conversationId)}/outputs`),
  openOutput: (conversationId: string, outputId: string) =>
    api<{ guest: boolean; tab?: BrowserSession }>(
      `/conversations/${encodeURIComponent(conversationId)}/open-output`,
      'POST',
      { outputId },
    ),
};
