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
          if (id.includes('@supabase')) return 'vendor-supabase';
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
  server: { port: 5173 },
});
