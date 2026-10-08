import type { Bot } from '../../shared/ai';
import { workspaceToolIds, type ToolAssignment } from '../../shared/toolAssignments';
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
    toolId = toolId === 'process' ? 'terminal' : toolId;
    if ((workspaceToolIds as readonly string[]).includes(toolId)) return;
    if (
      toolId.startsWith('custom:') &&
      this.repository.customTools(workspaceId).some((tool) => tool.id === toolId.slice(7))
    )
      return;
    throw new ApiError(400, 'Choose a workspace or custom tool in this workspace.');
  }
  allowed(bot: Bot, toolId: string) {
    if (toolId === 'skills' || toolId === 'register_custom_route') return true;
    if (toolId === 'process') toolId = 'terminal';
    const current = this.bot(bot.id);
    const override = this.repository.override(bot.id, toolId);
    if (override !== undefined) return override;
    if (toolId.startsWith('custom:')) {
      const item = this.repository
        .customTools(current.workspaceId)
        .find((tool) => tool.id === toolId.slice(7));
      return Boolean(item && (current.isMain || item.ownerBotId === current.id));
    }
    return (
      (workspaceToolIds as readonly string[]).includes(toolId) &&
      (current.isMain || (toolId !== 'manage_pursuit' && toolId !== 'manage_bot'))
    );
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
    toolId = toolId === 'process' ? 'terminal' : toolId;
    if (this.bot(botId).workspaceId !== workspaceId)
      throw new ApiError(403, 'Bot belongs to another workspace.');
    this.valid(workspaceId, toolId);
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
  initializeChild(caller: Bot, child: Bot, selected?: string[]) {
    selected = selected?.map((id) => (id === 'process' ? 'terminal' : id));
    const ids = [
      ...workspaceToolIds,
      ...this.repository.customTools(caller.workspaceId).map((tool) => 'custom:' + tool.id),
    ];
    this.validateSelection(caller, selected);
    for (const id of ids)
      this.set(
        child.workspaceId,
        child.id,
        id,
        this.allowed(caller, id) && (selected ? selected.includes(id) : this.allowed(child, id)),
      );
  }
  require(bot: Bot, toolId: string) {
    if (!this.allowed(bot, toolId))
      throw new ApiError(
        403,
        'This bot is not assigned ' + toolId + '. Ask the user to assign it in Tools.',
      );
  }
}
