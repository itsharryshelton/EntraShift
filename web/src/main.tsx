/**
 * Entry point. Loads self-hosted fonts (Inter + JetBrains Mono via @fontsource),
 * design tokens, global + component styles, initialises reduced-motion tracking,
 * and mounts the app.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Fonts (branding §4). Self-hosted so the admin app has no runtime CDN
// dependency behind SSO. Inter for UI/display, JetBrains Mono for data/logs.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';

import './styles/tokens.css';
import './styles/global.css';
import './styles/app.css';
import './components/components.css';

import App from './App';
import { initReducedMotion } from './lib/theme';

initReducedMotion();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
