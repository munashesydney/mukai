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
import { initializeBrowserSession } from './services/browserSession';
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

applyTheme(readPreferences(), window.matchMedia('(prefers-color-scheme: dark)').matches);

const root = ReactDOM.createRoot(document.getElementById('root')!);
void initializeBrowserSession()
  .then(() =>
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <ThemeProvider>
            <App />
          </ThemeProvider>
        </ErrorBoundary>
      </React.StrictMode>,
    ),
  )
  .catch(() =>
    root.render(
      <main style={{ padding: '48px', maxWidth: '680px', margin: 'auto' }}>
        <h1>Connect to Mukai</h1>
        <p>
          Open the connection link printed by <code>mukai serve</code> in your terminal.
        </p>
        <p>
          Run <code>mukai status</code> to find your running server’s connection link.
        </p>
      </main>,
    ),
  );
