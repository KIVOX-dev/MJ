import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api is forwarded to the local backend so the app and API share one origin (same as the Vercel rewrite in production).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } } },
});
