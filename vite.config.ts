import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { PrimeVueResolver } from '@primevue/auto-import-resolver';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    Components({
      resolvers: [PrimeVueResolver()],
      dts: true,
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `
          @use "@/shared/assets/sakai/layout/variables/_common" as *;
          @use "@/shared/assets/sakai/layout/variables/_dark" as *;
          @use "@/shared/assets/sakai/layout/variables/_light" as *;
        `
      }
    },
  },
  optimizeDeps: {
    // sqlite-wasm ships its own .wasm file that must be fetched as a real
    // asset next to the worker script, not pre-bundled by esbuild.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    // sqlite.worker.ts uses top-level `import` — classic workers can't.
    format: 'es',
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (id.includes('/primevue/') || id.includes('/@primevue/') || id.includes('/primeicons/')) {
            return 'vendor-prime';
          }

          if (id.includes('/vue/') || id.includes('/vue-router/') || id.includes('/pinia/')) {
            return 'vendor-vue';
          }

          if (id.includes('/@tanstack/')) {
            return 'vendor-tanstack';
          }

          if (id.includes('/chart.js/')) {
            return 'vendor-chart';
          }

          if (id.includes('/@sqlite.org/')) {
            return 'vendor-sqlite';
          }

          return 'vendor-misc';
        },
      },
    },
  },
  // Required for OPFS SyncAccessHandle Pool VFS + SharedArrayBuffer during
  // `vite dev`/`vite preview`. Production hosting must set the same two
  // headers — see vercel.json. Without them, chatStorageBootstrap.ts falls
  // back to the IndexedDB repositories instead of failing.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
