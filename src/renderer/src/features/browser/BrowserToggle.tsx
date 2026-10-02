import { PanelRight } from 'lucide-react';
import { IconButton } from '../../components/ui/IconButton';
import { useBrowserPanel } from './useBrowserPanel';

export function BrowserToggle() {
  const panel = useBrowserPanel();
  if (!panel?.tabs.length) return null;
  return (
    <IconButton
      label={panel.visible ? 'Hide browser panel' : 'Show browser panel'}
      className={panel.visible ? 'is-on' : ''}
      aria-expanded={panel.visible}
      aria-controls="browser-panel"
      onClick={() => panel.setVisible(!panel.visible)}
    >
      <PanelRight size={18} />
    </IconButton>
  );
}
