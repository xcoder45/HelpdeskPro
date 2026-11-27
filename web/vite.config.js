import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, resolve(process.cwd(), '..'), 'VITE_'),
    ...loadEnv(mode, process.cwd(), 'VITE_')
  };
  const target = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000';
  const proxy = {
    '/api': {
      target,
      changeOrigin: true
    }
  };

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      proxy
    },
    test: {
      environment: 'jsdom',
      environmentOptions: { jsdom: { url: 'http://localhost/' } },
      globals: true,
      setupFiles: ['./src/test/setup.js'],
      exclude: [...configDefaults.exclude, 'e2e/**']
    }
  };
});
