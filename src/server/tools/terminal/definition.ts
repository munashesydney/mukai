import { z } from 'zod';
import { terminalEnvironmentFields } from '../../../shared/terminal';
export const terminalDefinition = {
  name: 'terminal',
  title: 'Terminal & Processes',
  summary: 'Run local commands and manage background processes.',
  actions: ['run', 'list', 'poll', 'wait', 'log', 'write', 'kill'],
  description:
    'Run a fresh noninteractive shell without PTY (Windows PowerShell, otherwise sh), with local OS permissions. cwd is workspace-relative. Output is bounded; running results have a session id for process. background returns immediately; yieldMs sets the initial wait. timeoutSeconds defaults to 300 foreground/3600 background. Stop unneeded work. envFromSettings selects saved names; env is temporary nonsecret data. Automatic MUKAI_ROUTES_URL and MUKAI_ROUTES_TOKEN provide this workspace’s actual route address and temporary Bearer access to auth:mukai. Never override or save them.',
  inputSchema: z.object({
    ...terminalEnvironmentFields,
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
