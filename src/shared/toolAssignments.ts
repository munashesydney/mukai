export const workspaceToolIds = [
  'file_operations',
  'terminal',
  'browser',
  'computer_use',
  'media',
  'web_search',
  'memory',
  'communicate',
  'conversations',
  'manage_pursuit',
  'manage_bot',
  'register_custom_tool',
] as const;
export type ToolAssignment = { toolId: string; botId: string; enabled: boolean };
export const canonicalToolId = (id: string) =>
  id === 'image' ? 'media' : id === 'process' ? 'terminal' : id;
export const botNameSuggestions = ['Mukai', 'Scout', 'Nova', 'Atlas'];
