import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Bot, ChatMessage, FileArtifact } from '../../../../shared/ai';
import type { ChatServerOutput } from '../../../../shared/chatActivity';
import { chatActivityService } from '../../services/chatActivityService';
import { artifactService } from '../../services/artifactService';
import { chatActivityData } from './chatActivityData';

export function useChatActivity(
  conversationId: string,
  messages: ChatMessage[],
  bots: Bot[],
  botId: string,
) {
  const layoutRef = useRef<HTMLDivElement>(null);
  // Match the CSS container breakpoint, including chats beside a computer/browser panel.
  const [narrow, setNarrow] = useState(true);
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const measure = () => setNarrow(layout.getBoundingClientRect().width <= 700);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);
  const [outputs, setOutputs] = useState<ChatServerOutput[]>([]);
  const [artifacts, setArtifacts] = useState<FileArtifact[]>([]);
  const [error, setError] = useState('');
  const revision = messages
    .filter((message) => message.role === 'assistant')
    .map(
      (message) =>
        `${message.id}:${message.status}:${(message.activity || []).map((item) => `${item.id}:${item.status}`).join(',')}`,
    )
    .join('|');
  useEffect(() => {
    let alive = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const results = await Promise.allSettled([
        chatActivityService.outputs(conversationId),
        artifactService.forConversation(conversationId),
      ]);
      if (alive) {
        if (results[0].status === 'fulfilled') setOutputs(results[0].value);
        if (results[1].status === 'fulfilled') setArtifacts(results[1].value);
        setError(
          results.some((result) => result.status === 'rejected')
            ? 'Some activity could not be refreshed. Retrying…'
            : '',
        );
      }
      pending = false;
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [conversationId, revision]);
  const data = useMemo(
    () => chatActivityData(messages, outputs, artifacts, bots),
    [messages, outputs, artifacts, bots],
  );
  const storageKey = `mukai.chat-activity.${conversationId}`;
  const latestRun = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.activity?.length);
  const runKey = latestRun ? `${latestRun.id}:${latestRun.startedAt || ''}` : '';
  const working = latestRun?.status === 'streaming';
  function savedPreference() {
    try {
      return localStorage.getItem(storageKey) !== 'closed';
    } catch {
      return true;
    }
  }
  const [preference, setPreference] = useState(() => ({
    storageKey,
    runKey,
    narrow,
    open: false,
  }));
  const layoutChanged = preference.storageKey !== storageKey || preference.narrow !== narrow;
  // Wide chats open once per run; narrow chats only open through the activity button.
  if (layoutChanged || (working && preference.runKey !== runKey)) {
    setPreference({
      storageKey,
      runKey,
      narrow,
      open: narrow ? !layoutChanged && preference.open : working || savedPreference(),
    });
  }
  function setOpen(open: boolean) {
    setPreference({ storageKey, runKey, narrow, open });
    try {
      if (!narrow) localStorage.setItem(storageKey, open ? 'open' : 'closed');
    } catch {
      /* Optional preference. */
    }
  }
  const available = data.count > 0 || working;
  return {
    ...data,
    botId,
    layoutRef,
    conversationId,
    error,
    working,
    available,
    open: available && preference.open,
    setOpen,
  };
}
