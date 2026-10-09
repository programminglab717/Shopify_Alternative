import '@fontsource-variable/inter';
import '@fontsource/noto-nastaliq-urdu';
import 'virtual:hatti-tokens.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { registerServiceWorker } from './offline/register';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker keeps the admin's own files for opening offline (ADR-295); in development,
// Vite serves files that change as they are edited, and none is registered.
if (import.meta.env.PROD && 'serviceWorker' in navigator) void registerServiceWorker();
