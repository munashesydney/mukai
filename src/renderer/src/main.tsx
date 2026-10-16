import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import { App } from './app/App';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { ThemeProvider } from './features/appearance/ThemeProvider';
import { applyTheme, readPreferences } from './features/appearance/themes';
import { BrowserAuthGate } from './features/auth/BrowserAuthGate';
import { UserProfileProvider } from './features/profile/UserProfileProvider';
import './styles/profile.css';
import './styles/auth.css';
import './styles/tokens.css';
import './styles/global.css';
import './styles/appearance.css';
import './styles/ai.css';
import './styles/botHierarchy.css';
import './styles/pursuits.css';
import './styles/capabilities.css';
import './styles/memory.css';
import './styles/skills.css';
import './styles/computer.css';
import './styles/notifications.css';
import './styles/telegram.css';

applyTheme(readPreferences(), window.matchMedia('(prefers-color-scheme: dark)').matches);

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserAuthGate>
        <ThemeProvider>
          <UserProfileProvider>
            <App />
          </UserProfileProvider>
        </ThemeProvider>
      </BrowserAuthGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
