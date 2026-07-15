import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://localhost:7080',
        changeOrigin: false,
      },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'vendor-react';
          if (id.includes('react-router') || id.includes('@tanstack/react-query')) return 'vendor-data-router';
          if (id.includes('/radix-ui/') || id.includes('@radix-ui')) return 'vendor-radix';
          if (id.includes('/motion/') || id.includes('framer-motion')) return 'vendor-motion';
          if (id.includes('/lucide-react/')) return 'vendor-icons';
          return undefined;
        },
      },
    },
  },
});
