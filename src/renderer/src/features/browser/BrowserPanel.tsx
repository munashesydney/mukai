import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, RefreshCw, X, ExternalLink } from 'lucide-react';
import { browserService } from '../../services/browserService';
import { IconButton } from '../../components/ui/IconButton';
import { errorText } from '../../utils/errors';
import '../../styles/browser.css';
import { useBrowserPanel } from './useBrowserPanel';
import { browserPanelWidth } from './panelWidth';

export function BrowserPanel() {
  const panel = useBrowserPanel()!;
  const { tabs, setTabs, selected, setSelected, visible, setVisible, width, setWidth } = panel;
  const [error, setError] = useState(''),
    [address, setAddress] = useState(''),
    [resizing, setResizing] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const active = tabs.find((tab) => tab.id === selected) || tabs.at(-1);
  const activeId = active?.id,
    activeTarget = active?.target;
  useEffect(() => {
    const end = () => setResizing(false);
    window.addEventListener('blur', end);
    return () => window.removeEventListener('blur', end);
  }, []);
  useEffect(() => setAddress(active?.url || ''), [active?.id, active?.url]);
  useEffect(() => {
    if (!window.mukai?.setBrowserBounds) return;
    let previous = '';
    const update = () => {
      const rect = viewport.current?.getBoundingClientRect();
      const hide =
        !visible ||
        resizing ||
        activeTarget !== 'mukai' ||
        !rect ||
        Boolean(document.querySelector('[role="dialog"]'));
      const bounds = hide
        ? null
        : { id: activeId!, x: rect!.x, y: rect!.y, width: rect!.width, height: rect!.height };
      const serialized = JSON.stringify(bounds);
      if (previous === serialized) return;
      previous = serialized;
      void window.mukai!.setBrowserBounds(bounds).catch((caught) => setError(errorText(caught)));
    };
    update();
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    const mutations = new MutationObserver(update);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role'],
    });
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', update);
      void window.mukai?.setBrowserBounds(null).catch(() => {});
    };
  }, [visible, activeId, activeTarget, resizing]);
  async function control(action: string, url?: string) {
    if (!active) return;
    setError('');
    try {
      await browserService.control(active.id, action, url);
      if (action === 'close') setTabs((previous) => previous.filter((tab) => tab.id !== active.id));
    } catch (caught) {
      setError(errorText(caught));
    }
  }
  if (!tabs.length || !visible) return null;
  return (
    <aside
      id="browser-panel"
      className={`browser-panel ${resizing ? 'is-resizing' : ''}`}
      aria-label="Browser panel"
    >
      <div
        className="browser-resize-handle"
        role="separator"
        aria-label="Resize browser panel"
        aria-orientation="vertical"
        aria-valuemin={browserPanelWidth(0, window.innerWidth)}
        aria-valuemax={browserPanelWidth(window.innerWidth, window.innerWidth)}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setWidth(browserPanelWidth(window.innerWidth - event.clientX, window.innerWidth));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          setResizing(false);
        }}
        onLostPointerCapture={() => setResizing(false)}
        onPointerCancel={() => setResizing(false)}
        onDoubleClick={() => setWidth(640)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? window.innerWidth
                : width + (event.key === 'ArrowLeft' ? 20 : -20);
          setWidth(browserPanelWidth(next, window.innerWidth));
        }}
      >
        <span />
      </div>
      {resizing && <div className="browser-resize-shield" />}
      <header className="browser-panel-heading">
        <span>
          <Globe size={17} /> Browser
        </span>
        <IconButton label="Hide browser panel" onClick={() => setVisible(false)}>
          <X size={17} />
        </IconButton>
      </header>
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <button
            role="tab"
            aria-selected={active?.id === tab.id}
            key={tab.id}
            onClick={() => setSelected(tab.id)}
            title={tab.url}
          >
            {tab.target === 'chrome' && <ExternalLink size={12} />}
            <span>{tab.title || 'New tab'}</span>
          </button>
        ))}
      </div>
      <form
        className="browser-navigation"
        onSubmit={(event) => {
          event.preventDefault();
          void control('navigate', address);
        }}
      >
        <IconButton label="Browser back" onClick={() => void control('back')}>
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton label="Browser forward" onClick={() => void control('forward')}>
          <ArrowRight size={15} />
        </IconButton>
        <IconButton label="Reload page" onClick={() => void control('reload')}>
          <RefreshCw size={15} />
        </IconButton>
        <input
          aria-label="Browser address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <IconButton label="Close browser tab" onClick={() => void control('close')}>
          <X size={15} />
        </IconButton>
      </form>
      {error && (
        <p className="ai-alert" role="alert">
          {error}
        </p>
      )}
      <div ref={viewport} className="browser-viewport">
        {active?.target === 'chrome' ? (
          <div className="browser-placeholder">
            <ExternalLink size={30} />
            <h3>Open in Google Chrome</h3>
            <p>This tab is running in a separate Chrome window with its own Mukai profile.</p>
          </div>
        ) : !window.mukai ? (
          <div className="browser-placeholder">
            <Globe size={30} />
            <p>The embedded browser is available in the Mukai desktop app.</p>
          </div>
        ) : null}
      </div>
      <footer>
        {active?.target === 'chrome' ? 'Chrome window' : 'Mukai browser'} · Separate browser profile
      </footer>
    </aside>
  );
}
