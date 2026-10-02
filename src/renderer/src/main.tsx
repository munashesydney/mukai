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
import './styles/tokens.css';
import './styles/global.css';
import './styles/appearance.css';
import './styles/ai.css';
import './styles/pursuits.css';

applyTheme(readPreferences(), window.matchMedia('(prefers-color-scheme: dark)').matches);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
