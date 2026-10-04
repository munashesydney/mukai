export const workspaceToolIds = [
  'file_operations',
  'terminal',
  'browser',
  'memory',
  'manage_pursuit',
  'manage_bot',
  'register_custom_tool',
] as const;
export type ToolAssignment = { toolId: string; botId: string; enabled: boolean };
export const botNameSuggestions = ['Mukai', 'Scout', 'Nova', 'Atlas'];
