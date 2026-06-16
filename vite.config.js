import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
  },
  build: {
    // Never inline AudioWorklet modules as data: URIs — addModule() needs them
    // served as real files for reliable cross-browser loading.
    assetsInlineLimit: (filePath) =>
      /-processor\.js$/.test(filePath) ? false : undefined,
  },
});
