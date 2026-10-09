export const workspaceToolIds = [
  'file_operations',
  'terminal',
  'browser',
  'computer_use',
  'image',
  'web_search',
  'memory',
  'communicate',
  'conversations',
  'manage_pursuit',
  'manage_bot',
  'register_custom_tool',
] as const;
export type ToolAssignment = { toolId: string; botId: string; enabled: boolean };
export const botNameSuggestions = ['Mukai', 'Scout', 'Nova', 'Atlas'];
