import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// A API só escuta em 127.0.0.1; o navegador fala com ela pelo proxy abaixo.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
});
