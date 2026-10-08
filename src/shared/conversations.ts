export interface Conversation {
  id: string;
  workspaceId: string;
  kind: 'private' | 'space' | 'pursuit_run' | 'bot';
  name: string;
  description: string;
  botIds: string[];
  createdAt: string;
  updatedAt: string;
  ownerBotId: string | null;
  isWorking?: boolean;
}
export interface SpaceInput {
  name: string;
  description: string;
  botIds: string[];
}
export interface SpaceChatInput {
  requestId: string;
  text: string;
  botId: string | null;
}
