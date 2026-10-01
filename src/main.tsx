import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import { ChatRuntime } from './chat/application/runtime';
import { browserDependencies } from './session/browser';
import './app/global.scss';

const runtime = new ChatRuntime(browserDependencies());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App runtime={runtime} />
    </ErrorBoundary>
  </StrictMode>,
);
