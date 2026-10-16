/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// base relativa: o app pode ficar em qualquer subpasta/host estático (Netlify, GitHub Pages...)
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Barão Visitas',
        short_name: 'Barão',
        description: 'Nenhum cliente fica esquecido: cadência de visitas da Temperos Barão.',
        lang: 'pt-BR',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#fffcf6',
        theme_color: '#fcb400',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // o banco local (PGlite) tem ~17 MB de WebAssembly: precisa ir para o cache para abrir offline
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,png,webp,wasm,data,woff2,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/tile\.openstreetmap\.org\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mapa-tiles',
              expiration: { maxEntries: 800, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: { fs: { allow: ['..'] } }, // lê as migrações SQL de ../supabase
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { include: ['src/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 },
});
