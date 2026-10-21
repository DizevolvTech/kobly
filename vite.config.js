import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Kobly — Vite config. `@` → /src for clean absolute imports.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Bibliotecas pesadas em chunks próprios: cache estável entre deploys e
        // carregamento só quando a tela que usa (gráficos, importação de e-mail) abre.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('apexcharts')) return 'vendor-charts';
          if (id.includes('jszip') || id.includes('dompurify')) return 'vendor-email-import';
          if (id.includes('react')) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  test: {
    alias: { apexcharts: fileURLToPath(new URL('./src/__tests__/apexchartsStub.js', import.meta.url)) },
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    globals: false,
    setupFiles: ['./src/__tests__/setup.js'],
  },
  server: {
    port: 5173,
    // Em DEV, /api vai para a API do Kobly (VITE_API_PROXY, ex.: http://127.0.0.1:4121).
    proxy: process.env.VITE_API_PROXY ? { '/api': { target: process.env.VITE_API_PROXY, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } } : undefined,
  },
});
