import type { ChatServerOutput } from '../../../shared/chatActivity';
import type { BrowserSession } from '../../../shared/runtime';
import { api } from './http';

export const chatActivityService = {
  outputs: (conversationId: string) =>
    api<ChatServerOutput[]>(`/conversations/${encodeURIComponent(conversationId)}/outputs`),
  openOutput: (conversationId: string, outputId: string) =>
    api<{ guest: boolean; tab?: BrowserSession }>(
      `/conversations/${encodeURIComponent(conversationId)}/open-output`,
      'POST',
      { outputId },
    ),
};
