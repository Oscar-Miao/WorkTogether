import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/p': { target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3001', ws: true },
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
      '/bridge': { target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3001', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
