import '@fontsource-variable/inter';
import '@fontsource/noto-nastaliq-urdu';
import 'virtual:hatti-tokens.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { createReporter, reportUncaught } from './errors/reporting';
import { registerServiceWorker } from './offline/register';

// What fails in a built admin is reported to the core (ADR-745); in development, the console has it.
const reporter = import.meta.env.PROD
  ? createReporter({ release: import.meta.env.VITE_RELEASE || undefined })
  : null;
if (reporter) reportUncaught(reporter);

createRoot(
  document.getElementById('root')!,
  // What React could not render, whether nothing caught it, which goes on to the browser as
  // React would send it, or a boundary showed its fallback in its place.
  reporter
    ? {
        onUncaughtError: (error) => {
          reporter.report(error);
          window.reportError(error);
        },
        onCaughtError: (error) => reporter.report(error),
      }
    : {},
).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker keeps the admin's own files for opening offline (ADR-295); in development,
// Vite serves files that change as they are edited, and none is registered.
if (import.meta.env.PROD && 'serviceWorker' in navigator) void registerServiceWorker();
