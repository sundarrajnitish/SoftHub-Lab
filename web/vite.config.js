import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The web app imports the shared core (../packages/core) so that, without
// VITE_API_URL, it runs the whole backend in the browser ("local mode").
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@core': fileURLToPath(new URL('../packages/core/src', import.meta.url)) } },
  server: { fs: { allow: ['..'] } },
  // amazon-cognito-identity-js expects a Node-style `global`
  define: { global: 'globalThis' },
});
