import { z } from 'zod';
import type { ProcessService } from '../../services/processService';
import { processDefinition, terminalDefinition } from './definition';
import { executeRuntime, type RuntimeToolContext } from '../runtimeContext';
export function executeTerminal(
  input: z.infer<typeof terminalDefinition.inputSchema>,
  context: RuntimeToolContext & { processes: ProcessService; folder: string },
  callId: string,
) {
  return executeRuntime(context, callId, 'terminal', 'run', input.command, () =>
    context.processes.run(context.owner, context.folder, input, context.signal),
  );
}
export function executeProcess(
  input: z.infer<typeof processDefinition.inputSchema>,
  context: RuntimeToolContext & { processes: ProcessService },
  callId: string,
) {
  return executeRuntime(context, callId, 'terminal', input.action, input.sessionId || '', () => {
    const { processes, owner } = context;
    if (input.action === 'list') return processes.list(owner);
    if (!input.sessionId) throw new Error('sessionId is required for this process action.');
    switch (input.action) {
      case 'kill':
        return processes.kill(owner, input.sessionId);
      case 'write':
        if (input.text === undefined) throw new Error('text is required for write.');
        return processes.write(owner, input.sessionId, input.text);
      case 'wait':
        return processes.wait(owner, input.sessionId, input.waitMs ?? 1000, context.signal);
      default:
        return processes.read(owner, input.sessionId, input.offset);
    }
  });
}
