import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import type { BrowserSession } from '../../../../shared/runtime';
import { browserService } from '../../services/browserService';
import { BrowserPanelContext, useBrowserPanel } from './useBrowserPanel';
import { BROWSER_WIDTH_KEY, browserPanelWidth, loadBrowserPanelWidth } from './panelWidth';

export function BrowserWorkspace({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const [tabs, setTabs] = useState<BrowserSession[]>([]),
    [selected, setSelected] = useState(''),
    [visible, setVisible] = useState(false),
    [windowWidth, setWindowWidth] = useState(window.innerWidth),
    [preferredWidth, setWidth] = useState(loadBrowserPanelWidth);
  const seen = useRef(new Set<string>()),
    activation = useRef(0);
  useEffect(() => {
    try {
      localStorage.setItem(BROWSER_WIDTH_KEY, String(preferredWidth));
    } catch {
      /* The panel still resizes when local storage is unavailable. */
    }
  }, [preferredWidth]);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    let alive = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const values = await browserService.list(workspaceId);
        if (!alive) return;
        const fresh = values.filter((tab) => !seen.current.has(tab.id));
        for (const tab of values) seen.current.add(tab.id);
        setTabs(values);
        if (fresh.length) {
          setSelected(fresh.at(-1)!.id);
          setVisible(true);
        }
        const requested = [...values].sort((a, b) => (b.activation || 0) - (a.activation || 0))[0];
        if (requested && (requested.activation || 0) > activation.current) {
          activation.current = requested.activation!;
          setSelected(requested.id);
          setVisible(true);
        }
      } catch {
        /* Chat connection errors have their own UI. */
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      void window.mukai?.setBrowserBounds(null).catch(() => {});
    };
  }, [workspaceId]);
  return (
    <BrowserPanelContext.Provider
      value={{
        tabs,
        setTabs,
        selected,
        setSelected,
        visible,
        setVisible,
        width: browserPanelWidth(preferredWidth, windowWidth),
        setWidth,
      }}
    >
      {children}
    </BrowserPanelContext.Provider>
  );
}

export function BrowserLayout({ children }: { children: ReactNode }) {
  const browser = useBrowserPanel();
  return (
    <div
      className="app-shell"
      style={{ '--browser-panel-width': `${browser?.width || 640}px` } as CSSProperties}
    >
      {children}
    </div>
  );
}
