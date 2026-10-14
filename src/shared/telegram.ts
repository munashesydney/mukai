/** Public Telegram contracts. Credentials and Telegram message bodies never belong here. */
export const telegramUserMessagePrefix =
  'Message coming from the Telegram integration by the user.';

export interface TelegramUser {
  id: number;
  firstName: string;
  username?: string;
}

export interface TelegramBotIdentity {
  id: number;
  username: string;
  firstName: string;
}

export interface TelegramWorkspaceAccess {
  id: string;
  name: string;
  enabled: boolean;
  /** null follows the workspace's current main bot. */
  botId: string | null;
  bots: { id: string; name: string; isMain: boolean }[];
}

export interface TelegramAccessInput {
  workspaces: { workspaceId: string; botId: string | null }[];
}

export interface TelegramStatus {
  configured: boolean;
  enabled: boolean;
  bot: TelegramBotIdentity | null;
  owner: TelegramUser | null;
  pairing: {
    expiresAt: string;
    code?: string;
    url?: string;
    candidate?: TelegramUser | null;
  } | null;
  workspaces: TelegramWorkspaceAccess[];
  runtime: {
    state: 'stopped' | 'connecting' | 'polling' | 'error';
    error: string | null;
    lastPollAt: string | null;
  };
  queue: { pending: number; uncertain: number };
}
