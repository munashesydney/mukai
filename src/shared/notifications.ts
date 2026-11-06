import type { Conversation } from './conversations';

export interface NotificationSource {
  conversationId: string;
  messageId: string;
  name: string;
  kind: Conversation['kind'];
  runId?: string;
  pursuitId?: string;
}

export interface BotNotification {
  id: string;
  workspaceId: string;
  botId: string;
  botName: string;
  title: string;
  message: string;
  sourceConversationId: string;
  sourceKind: string;
  createdAt: string;
  readAt: string | null;
  conversationId: string | null;
}

export interface NotificationInbox {
  items: BotNotification[];
  total: number;
  unread: number;
}
