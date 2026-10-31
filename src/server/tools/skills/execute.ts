import { tool } from 'ai';
import type { Bot, ChatActivity } from '../../../shared/ai';
import type { SkillService } from '../../skills/service';
import { skillsDefinition } from './definition';
import { executeRuntime } from '../runtimeContext';
import { RUNTIME_TOOL_CALL_LIMIT } from '../../services/responsePolicy';
export function skillTools(context: {
  bot: Bot;
  conversationId: string;
  maxContextBytes?: number;
  skills: SkillService;
  signal: AbortSignal;
  onActivity: (activity: ChatActivity) => void;
}) {
  const runtime = {
    ...context,
    owner: {
      workspaceId: context.bot.workspaceId,
      botId: context.bot.id,
      conversationId: context.conversationId,
    },
    budget: { remaining: RUNTIME_TOOL_CALL_LIMIT },
  };
  return {
    skills: tool({
      description: skillsDefinition.description,
      inputSchema: skillsDefinition.inputSchema,
      execute: (input, options) =>
        executeRuntime(
          runtime,
          options.toolCallId,
          'skills',
          input.operation,
          input.id || input.name || input.url || input.query || '',
          async () => {
            const { skills, bot, conversationId } = context;
            const w = bot.workspaceId;
            const id = () => {
              if (!input.id)
                throw new Error(
                  'A skill ID is required. Use {operation:"search",query:"keywords"}, then pass a returned id. To load by exact name, use {operation:"load",name:"exact-skill-name"}.',
                );
              return input.id;
            };
            switch (input.operation) {
              case 'search':
                return {
                  skills: skills.list(w, input.query).slice(0, 40),
                  note: 'Results are ranked by relevance. Load directly with a returned id or exact name. Disabled skills must be enabled before loading.',
                };
              case 'inspect': {
                const skill = skills.inspect(w, id());
                return {
                  ...skill,
                  files: skill.files.map((file) => ({ path: file.path, encoding: file.encoding })),
                };
              }
              case 'load': {
                const reference = input.id || input.name;
                if (!reference)
                  throw new Error(
                    'Load requires id or exact name. Example: {operation:"load",name:"mukai-api-reference"}. Use {operation:"search",query:"keywords"} to discover skills.',
                  );
                return skills.load(w, bot.id, conversationId, reference, context.maxContextBytes);
              }
              case 'unload':
                return skills.unload(w, bot.id, conversationId, id());
              case 'read':
                if (!input.path)
                  throw new Error(
                    'Read requires a relative path from load or inspect, for example {operation:"read",id:"...",path:"references/checklist.md"}. Load already returns the main instructions.',
                  );
                return skills.read(w, id(), input.path, input.offset);
              case 'create':
                if (!input.bundle) throw new Error('A skill bundle is required.');
                return summary(skills.save(w, input.bundle));
              case 'update':
                if (!input.bundle) throw new Error('A skill bundle is required.');
                return summary(skills.save(w, input.bundle, id(), input.expectedVersion));
              case 'import': {
                if (!input.url) throw new Error('A GitHub URL is required.');
                const bundle = await skills.preview(input.url, context.signal);
                context.signal.throwIfAborted();
                return summary(skills.save(w, bundle, input.id, input.expectedVersion));
              }
              case 'enable':
                return summary(skills.enable(w, id(), true));
              case 'disable':
                return summary(skills.enable(w, id(), false));
              case 'remove':
                return skills.remove(w, id());
            }
          },
        ),
    }),
  };
}
function summary<T extends { files: unknown }>(skill: T) {
  const info = { ...skill };
  delete (info as Partial<T>).files;
  return info;
}
