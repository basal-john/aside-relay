import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import stylex from '@stylexjs/unplugin';

const backendTarget = 'http://127.0.0.1:8800';

export default defineConfig({
  root: 'web',
  plugins: [stylex.vite({ useCSSLayers: true }), react(), babel({ presets: [reactCompilerPreset()] })],
  publicDir: false,
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': backendTarget,
      '/ws': { target: 'ws://127.0.0.1:8800', ws: true },
      '/icons': backendTarget,
      '/vendor': backendTarget,
      '/sw.js': backendTarget,
      '/manifest.webmanifest': backendTarget
    }
  }
});
