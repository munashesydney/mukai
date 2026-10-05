import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, ProviderSettings, Workspace } from '../../../../shared/ai';
import { botService } from '../../services/botService';
import { providerService } from '../../services/providerService';
import { errorText } from '../../utils/errors';
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
        workspaces.find((workspace) => workspace.id === workspaceId) || workspaces[0];
      if (!selected) throw new Error('No workspace is available. Restart Mukai.');
      const bots = await botService.list(selected.id);
      if (current !== revision.current) return;
      setData({ bots, providers, workspaces });
      setWorkspaceId(selected.id);
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
      if (pending) return;
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
  };
}
