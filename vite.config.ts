import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 3000,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 4096,
  },
});
