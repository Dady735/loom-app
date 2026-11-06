import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', allowedHosts: true },
  build: {
    chunkSizeWarningLimit: 750,
    rollupOptions: { output: { manualChunks: { charts: ['recharts'], scanner: ['@zxing/browser', '@zxing/library'] } } },
  },
});
