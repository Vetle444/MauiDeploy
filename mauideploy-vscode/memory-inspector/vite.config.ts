import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: './',
  publicDir: false,
  plugins: [react(), {
    name: 'local-only-html',
    apply: 'build',
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
        },
        injectTo: 'head-prepend',
      }];
    },
  }],
  server: { host: '127.0.0.1', port: 5173, fs: { allow: ['..'] } },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    outDir: mode === 'toolbox' ? '../out/toolbox' : '../out/memory-inspector',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: mode === 'toolbox' ? 'toolbox.html' : 'index.html',
      output: {
        entryFileNames: mode === 'toolbox' ? 'toolbox.js' : 'inspector.js',
        assetFileNames: asset => {
          if (asset.names.some(name => name.endsWith('.css'))) return mode === 'toolbox' ? 'toolbox.css' : 'inspector.css';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
}));
