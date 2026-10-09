import { MainBotBadge } from '../../components/ui/MainBotBadge';
import { ArrowUpRight, ChevronDown, ChevronUp, Focus, GitBranch, Minus, Plus } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Bot } from '../../../../shared/ai';
import { Avatar } from '../../components/ui/Avatar';

const clampZoom = (value: number) => Math.max(0.4, Math.min(2, Math.round(value * 100) / 100));

export function BotHierarchyPage({
  bots,
  loading,
  error,
  onOpen,
  onCreate,
}: {
  bots: Bot[];
  loading: boolean;
  error: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const previousZoom = useRef(1);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  function centerView() {
    const view = canvas.current;
    if (view)
      view.scrollTo({
        left: (view.scrollWidth - view.clientWidth) / 2,
        top: (view.scrollHeight - view.clientHeight) / 2,
      });
  }
  useLayoutEffect(() => {
    const view = canvas.current;
    if (!view) return;
    const ratio = zoom / previousZoom.current;
    view.scrollLeft = (view.scrollLeft + view.clientWidth / 2) * ratio - view.clientWidth / 2;
    view.scrollTop = (view.scrollTop + view.clientHeight / 2) * ratio - view.clientHeight / 2;
    previousZoom.current = zoom;
  }, [zoom]);
  useLayoutEffect(() => {
    centerView();
  }, [loading, bots.length]);
  useEffect(() => {
    const view = canvas.current;
    if (!view) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((value) => clampZoom(value * Math.exp(-event.deltaY * 0.002)));
    };
    view.addEventListener('wheel', wheel, { passive: false });
    const resize = new ResizeObserver(centerView);
    resize.observe(view);
    return () => {
      view.removeEventListener('wheel', wheel);
      resize.disconnect();
    };
  }, [loading, bots.length, error]);
  const ids = new Set(bots.map((bot) => bot.id));
  const roots = bots.filter((bot) => !bot.createdBy || !ids.has(bot.createdBy));
  roots.sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name));
  const children = new Map<string, Bot[]>();
  for (const bot of bots) {
    if (bot.createdBy && ids.has(bot.createdBy)) {
      const siblings = children.get(bot.createdBy) || [];
      siblings.push(bot);
      children.set(bot.createdBy, siblings);
    }
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.name.localeCompare(b.name));
  function branch(bot: Bot, ancestors = new Set<string>()) {
    if (ancestors.has(bot.id)) return null;
    const path = new Set([...ancestors, bot.id]);
    const reports = (children.get(bot.id) || []).filter((child) => !path.has(child.id));
    return (
      <li key={bot.id} className="bot-tree-branch">
        <button
          className={`bot-tree-card ${bot.isMain ? 'is-main' : ''}`}
          onClick={() => onOpen(bot.id)}
          aria-label={`Open ${bot.name}, ${bot.role}`}
        >
          <Avatar person={bot.avatar} />
          <span className="bot-tree-copy">
            <strong>
              {bot.name}
              {bot.isMain && <MainBotBadge />}
            </strong>
            <span className="bot-tree-role" title={bot.role}>
              {bot.role}
            </span>
          </span>
          <ArrowUpRight size={14} className="bot-tree-open" />
        </button>
        {!!reports.length && (
          <div className="bot-tree-toggle-wrap">
            <button
              className="bot-tree-toggle"
              aria-label={`${collapsed.has(bot.id) ? 'Expand' : 'Collapse'} ${bot.name}'s team`}
              aria-expanded={!collapsed.has(bot.id)}
              onClick={() =>
                setCollapsed((value) => {
                  const next = new Set(value);
                  if (next.has(bot.id)) next.delete(bot.id);
                  else next.add(bot.id);
                  return next;
                })
              }
            >
              {collapsed.has(bot.id)
                ? `${reports.length} ${reports.length === 1 ? 'bot' : 'bots'}`
                : 'Collapse'}
              {collapsed.has(bot.id) ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            </button>
          </div>
        )}
        {!!reports.length && !collapsed.has(bot.id) && (
          <ul className="bot-tree-children" aria-label={`Bots created by ${bot.name}`}>
            {reports.map((child) => branch(child, path))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <main className="conversation bot-hierarchy-page">
      <header className="conversation-header conversation-header--minimal">
        <div className="conversation-heading">
          <div className="heading-identity">
            <span className="heading-space">
              <GitBranch size={20} />
            </span>
            <div>
              <h1>Bot Hierarchy</h1>
              <p>
                {bots.length} {bots.length === 1 ? 'bot' : 'bots'} in your workspace
              </p>
            </div>
          </div>
          <button className="button" onClick={onCreate}>
            <Plus size={16} /> Add bot
          </button>
        </div>
      </header>
      {error ? (
        <p className="ai-alert" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="bot-hierarchy-empty">Loading your team…</p>
      ) : !bots.length ? (
        <div className="bot-hierarchy-empty">
          <h2>Your team starts with one bot.</h2>
          <p>Add your first bot to lead the workspace. Bots it creates will appear beneath it.</p>
          <button className="button" onClick={onCreate}>
            Add your first bot <ArrowUpRight size={15} />
          </button>
        </div>
      ) : (
        <>
          <div
            ref={canvas}
            className={`bot-hierarchy-canvas ${dragging ? 'is-dragging' : ''}`}
            tabIndex={0}
            role="region"
            aria-label="Bot organization chart; scroll to explore"
            onPointerDown={(event) => {
              if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
              const view = event.currentTarget;
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                left: view.scrollLeft,
                top: view.scrollTop,
              };
              view.setPointerCapture(event.pointerId);
              setDragging(true);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              if (!drag.current) return;
              event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
              event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
            }}
            onPointerUp={() => {
              drag.current = null;
              setDragging(false);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(false);
            }}
            onLostPointerCapture={() => {
              drag.current = null;
              setDragging(false);
            }}
          >
            <div
              className="bot-hierarchy-forest"
              style={{ zoom, minWidth: `${100 / zoom}%`, minHeight: `${100 / zoom}%` }}
            >
              {roots.map((root) => (
                <section
                  className="bot-hierarchy-team"
                  key={root.id}
                  aria-label={`${root.name} and its team`}
                >
                  <span className="bot-hierarchy-origin">
                    {root.isMain
                      ? 'WORKSPACE LEAD'
                      : root.createdBy
                        ? 'CREATOR UNAVAILABLE'
                        : 'ADDED BY YOU'}
                  </span>
                  <ul className="bot-tree-root">{branch(root)}</ul>
                </section>
              ))}
            </div>
          </div>
          <div className="bot-hierarchy-toolbar">
            <p>Drag to explore · Ctrl / ⌘ + scroll to zoom</p>
            <div className="bot-hierarchy-zoom">
              <button aria-label="Center view" title="Center view" onClick={centerView}>
                <Focus size={17} />
              </button>
              <span className="bot-hierarchy-control-divider" />
              <button
                aria-label="Zoom out"
                disabled={zoom <= 0.4}
                onClick={() => setZoom((value) => clampZoom(value - 0.1))}
              >
                <Minus size={15} />
              </button>
              <button
                className="bot-hierarchy-zoom-value"
                aria-label="Reset zoom"
                title="Reset zoom"
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                aria-label="Zoom in"
                disabled={zoom >= 2}
                onClick={() => setZoom((value) => clampZoom(value + 0.1))}
              >
                <Plus size={15} />
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
