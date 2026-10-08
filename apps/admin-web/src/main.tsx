import '@fontsource-variable/inter';
import '@fontsource/noto-nastaliq-urdu';
import 'virtual:hatti-tokens.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
