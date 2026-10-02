import { createContext, useContext } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { BrowserSession } from '../../../../shared/runtime';

export interface BrowserPanelState {
  tabs: BrowserSession[];
  setTabs: Dispatch<SetStateAction<BrowserSession[]>>;
  selected: string;
  setSelected: Dispatch<SetStateAction<string>>;
  visible: boolean;
  setVisible: Dispatch<SetStateAction<boolean>>;
  width: number;
  setWidth: Dispatch<SetStateAction<number>>;
}
export const BrowserPanelContext = createContext<BrowserPanelState | null>(null);
export const useBrowserPanel = () => useContext(BrowserPanelContext);
