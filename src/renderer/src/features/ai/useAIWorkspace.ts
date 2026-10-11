import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, ProviderSettings, Workspace } from '../../../../shared/ai';
import { botService } from '../../services/botService';
import { providerService } from '../../services/providerService';
import { errorText } from '../../utils/errors';
import { chatStore } from './chatStore';
import { clearDeletedWorkspaceStorage, deletedChatKeys } from '../workspace/deletionStorage';
import { workspaceService } from '../../services/workspaceService';

export function useAIWorkspace() {
  const [workspaceId, setWorkspaceId] = useState(() => {
    try {
      return localStorage.getItem('mukai.active-workspace') || 'default';
    } catch {
      return 'default';
    }
  });
  const [data, setData] = useState<{
    bots: Bot[];
    providers: ProviderSettings[];
    workspaces: Workspace[];
  }>({ bots: [], providers: [], workspaces: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const [workspaces, providers] = await Promise.all([
        workspaceService.list(),
        providerService.list(),
      ]);
      const selected =
        workspaces.find((workspace) => workspace.id === workspaceId) ||
        workspaces.find((workspace) => !workspace.deleting) ||
        workspaces[0];
      const bots = selected && !selected.deleting ? await botService.list(selected.id) : [];
      if (current !== revision.current) return;
      setData({ bots, providers, workspaces });
      setWorkspaceId(selected?.id || '');
      setError('');
    } catch (error) {
      if (current === revision.current) setError(errorText(error));
    } finally {
      if (current === revision.current) setLoading(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let alive = true,
      pending = false;
    const timer = window.setInterval(async () => {
      if (pending || !workspaceId) return;
      pending = true;
      const current = revision.current;
      try {
        const bots = await botService.list(workspaceId);
        if (alive && current === revision.current)
          setData((previous) =>
            JSON.stringify(previous.bots) === JSON.stringify(bots)
              ? previous
              : { ...previous, bots },
          );
      } catch {
        /* The main refresh reports connection errors. */
      } finally {
        pending = false;
      }
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [workspaceId]);
  useEffect(() => {
    try {
      localStorage.setItem('mukai.active-workspace', workspaceId);
    } catch {
      /* The workspace still works without a preference cache. */
    }
  }, [workspaceId]);
  function selectWorkspace(id: string) {
    if (id === workspaceId) return;
    revision.current++;
    setLoading(true);
    setData((data) => ({ ...data, bots: [] }));
    setWorkspaceId(id);
  }
  async function deleteWorkspace(id: string, name: string) {
    let result;
    try {
      result = await workspaceService.remove(id, name);
    } catch (error) {
      await refresh();
      throw error;
    }
    // Remove stale views immediately, even if the following network refresh fails.
    revision.current++;
    const remaining = data.workspaces.filter((workspace) => workspace.id !== id);
    setData((previous) => ({
      ...previous,
      workspaces: remaining,
      bots: id === workspaceId ? [] : previous.bots,
    }));
    if (id === workspaceId)
      setWorkspaceId(
        remaining.find((workspace) => !workspace.deleting)?.id || remaining[0]?.id || '',
      );
    try {
      clearDeletedWorkspaceStorage(localStorage, id, result);
    } catch {
      /* Server deletion is authoritative. */
    }
    chatStore.forget(deletedChatKeys(result));
    await refresh();
  }
  return {
    ...data,
    workspaceId,
    workspace: data.workspaces.find((workspace) => workspace.id === workspaceId),
    loading,
    error,
    refresh,
    updateBot: (bot: Bot) => {
      revision.current++;
      setData((previous) => ({
        ...previous,
        bots: previous.bots.map((item) => (item.id === bot.id ? bot : item)),
      }));
      void refresh();
    },
    selectWorkspace,
    deleteWorkspace,
  };
}
