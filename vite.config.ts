import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client'],
          markdown: ['react-markdown', 'remark-gfm'],
          icons: ['lucide-react'],
          motion: ['gsap'],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4300,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
