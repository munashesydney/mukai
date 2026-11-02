import type { Bot } from '../../shared/ai';
import {
  workspaceToolIds,
  canonicalToolId,
  type ToolAssignment,
} from '../../shared/toolAssignments';
import type { ToolAssignmentRepository } from '../repositories/toolAssignmentRepository';
import { ApiError } from '../config';

export class ToolAccessService {
  constructor(private repository: ToolAssignmentRepository) {}
  private bot(id: string) {
    const bot = this.repository.bot(id);
    if (!bot) throw new ApiError(404, 'Bot not found.');
    return bot;
  }
  private valid(workspaceId: string, toolId: string) {
    toolId = canonicalToolId(toolId);
    if ((workspaceToolIds as readonly string[]).includes(toolId)) return;
    if (
      toolId.startsWith('custom:') &&
      this.repository.customTools(workspaceId).some((tool) => tool.id === toolId.slice(7))
    )
      return;
    throw new ApiError(400, 'Choose a workspace or custom tool in this workspace.');
  }
  allowed(bot: Bot, toolId: string) {
    if (toolId === 'ask') toolId = 'communicate';
    if (toolId === 'skills' || toolId === 'register_custom_route') return true;
    toolId = canonicalToolId(toolId);
    const current = this.bot(bot.id);
    if (toolId === 'manage_bot') return true;
    const override = this.repository.override(bot.id, toolId);
    if (toolId.startsWith('custom:')) {
      const item = this.repository
        .customTools(current.workspaceId)
        .find((tool) => tool.id === toolId.slice(7));
      return Boolean(item && (override ?? true));
    }
    if (override !== undefined) return override;
    return (workspaceToolIds as readonly string[]).includes(toolId);
  }
  list(workspaceId: string): ToolAssignment[] {
    const ids = [
      ...workspaceToolIds,
      ...this.repository.customTools(workspaceId).map((tool) => 'custom:' + tool.id),
    ];
    return this.repository.bots(workspaceId).flatMap((bot) => {
      return ids.map((toolId) => ({ botId: bot.id, toolId, enabled: this.allowed(bot, toolId) }));
    });
  }
  set(workspaceId: string, botId: string, toolId: string, enabled: boolean) {
    toolId = canonicalToolId(toolId);
    if (this.bot(botId).workspaceId !== workspaceId)
      throw new ApiError(403, 'Bot belongs to another workspace.');
    this.valid(workspaceId, toolId);
    if (toolId === 'manage_bot') {
      if (!enabled)
        throw new ApiError(
          400,
          'Bots access is required. Available actions are determined by the bot and conversation.',
        );
      return { botId, toolId, enabled: true };
    }
    this.repository.set(botId, toolId, enabled);
    return { botId, toolId, enabled };
  }
  validateSelection(caller: Bot, selected?: string[]) {
    if (selected)
      for (const id of selected) {
        this.valid(caller.workspaceId, id);
        if (!this.allowed(caller, id))
          throw new ApiError(403, 'You cannot grant a tool you are not assigned: ' + id);
      }
  }
  validateToolChanges(
    caller: Bot,
    child: Bot,
    changes: { toolIds?: string[]; addToolIds?: string[]; removeToolIds?: string[] },
  ) {
    if (!this.bot(caller.id).isMain || caller.workspaceId !== child.workspaceId)
      throw new ApiError(403, 'Only the workspace main bot can change bot tool access.');
    const selected = changes.toolIds?.map(canonicalToolId);
    const added = changes.addToolIds?.map(canonicalToolId) || [];
    const removed = changes.removeToolIds?.map(canonicalToolId) || [];
    if (selected && (changes.addToolIds !== undefined || changes.removeToolIds !== undefined))
      throw new ApiError(400, 'Use either toolIds or addToolIds/removeToolIds.');
    if (added.some((id) => removed.includes(id)))
      throw new ApiError(400, 'A tool cannot be both added and removed.');
    this.validateSelection(caller, selected);
    this.validateSelection(caller, added);
    for (const id of removed) this.valid(child.workspaceId, id);
    if (removed.includes('manage_bot')) throw new ApiError(400, 'Bots access is required.');
    const ids = [
      ...workspaceToolIds,
      ...this.repository.customTools(child.workspaceId).map((tool) => 'custom:' + tool.id),
    ];
    const updates = selected
      ? ids
          .filter((id) => id !== 'manage_bot')
          .map((id) => ({ id, enabled: selected.includes(id) }))
      : [
          ...added.map((id) => ({ id, enabled: true })),
          ...removed.map((id) => ({ id, enabled: false })),
        ];
    return updates;
  }
  updateTools(
    caller: Bot,
    child: Bot,
    changes: { toolIds?: string[]; addToolIds?: string[]; removeToolIds?: string[] },
  ) {
    this.repository.setMany(child.id, this.validateToolChanges(caller, child, changes));
  }
  describe(bot: Bot) {
    return [
      ...workspaceToolIds.map((id) => ({ id, name: id })),
      ...this.repository
        .customTools(bot.workspaceId)
        .map((tool) => ({ id: 'custom:' + tool.id, name: tool.name })),
    ].map((tool) => ({ ...tool, enabled: this.allowed(bot, tool.id) }));
  }
  require(bot: Bot, toolId: string) {
    if (!this.allowed(bot, toolId))
      throw new ApiError(
        403,
        'This bot is not assigned ' + toolId + '. Ask the user to assign it in Tools.',
      );
  }
}
