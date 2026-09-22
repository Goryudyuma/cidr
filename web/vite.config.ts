import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Match static hosts' directory redirects instead of serving the Japanese SPA
// fallback when /en is opened without its trailing slash during development.
function englishDirectory(request: IncomingMessage, response: ServerResponse, next: () => void): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/en') {
    response.writeHead(308, { Location: `/en/${url.search}` });
    response.end();
    return;
  }
  next();
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [{
    name: 'english-directory-redirect',
    configureServer(server) { server.middlewares.use(englishDirectory); },
    configurePreviewServer(server) { server.middlewares.use(englishDirectory); },
  }],
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: {
        ja: fileURLToPath(new URL('./index.html', import.meta.url)),
        en: fileURLToPath(new URL('./en/index.html', import.meta.url)),
      },
    },
  },
  worker: { format: 'es' },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
