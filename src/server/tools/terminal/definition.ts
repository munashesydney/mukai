import { z } from 'zod';
export const terminalDefinition = {
  name: 'terminal',
  title: 'Terminal & Processes',
  summary: 'Run local commands and manage background processes.',
  actions: ['run', 'list', 'poll', 'wait', 'log', 'write', 'kill'],
  description:
    'Run a local shell command in the workspace folder. Windows uses PowerShell; other systems use sh. This is a local shell, not a filesystem sandbox. cwd is relative to the workspace; each command starts a fresh shell. Never claim a command ran unless it succeeded. Output is bounded. If still running after yieldMs, returns a session id: use process to wait, poll, read logs, send stdin or kill. background=true returns immediately. timeoutSeconds limits total lifetime (default 300 seconds foreground / 3600 background). Only launch background work needed for the user task; stop unneeded processes. Commands run non-interactively without a PTY.',
  inputSchema: z.object({
    command: z.string().trim().min(1).max(16000),
    cwd: z.string().max(1000).optional(),
    background: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(1).max(86400).optional(),
    yieldMs: z.number().int().min(0).max(30000).optional(),
  }),
};
export const processDefinition = {
  name: 'process',
  title: 'Processes',
  summary: 'Inspect and control processes started by this conversation.',
  actions: ['list', 'poll', 'wait', 'log', 'write', 'kill'],
  description:
    'Manage terminal sessions owned by this bot in this conversation. list shows sessions. poll reads status and output. log accepts offset returned as nextOffset; truncated means older output was discarded. wait waits up to waitMs (maximum 30 seconds). write sends text to stdin (include a newline if required). kill stops the session and its process tree. Sessions and logs last for the current Mukai runtime; they do not survive restart.',
  inputSchema: z.object({
    action: z.enum(['list', 'poll', 'wait', 'log', 'write', 'kill']),
    sessionId: z.string().uuid().optional(),
    offset: z.number().int().min(0).optional(),
    waitMs: z.number().int().min(0).max(30000).optional(),
    text: z.string().max(16000).optional(),
  }),
};
