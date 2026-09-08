import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// Theme tokens (src/styles/tokens.css light root): paper + oxblood.
const THEME_COLOR = '#7b1e22' // --oxblood
const BACKGROUND_COLOR = '#f5f1e6' // --paper

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Non-VITE_ vars (e.g. the service-role key used only by the integration
  // test) are not auto-exposed to import.meta.env, so surface it explicitly
  // to the test runtime. Loaded from .env / .env.local (both gitignored).
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Installable PWA (slice 16). generateSW (workbox) precaches the built
      // app shell so it opens offline at the shell level; live data still needs
      // the network. Supabase REST/Realtime/Storage is never cached.
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icons/apple-touch-icon.png'],
        manifest: {
          name: 'Poker Friends',
          short_name: 'Poker Friends',
          description: 'Liga de póker — tabla, fechas, check-in y torneo en vivo.',
          lang: 'es',
          dir: 'ltr',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          theme_color: THEME_COLOR,
          background_color: BACKGROUND_COLOR,
          categories: ['sports', 'games'],
          icons: [
            { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            {
              src: 'icons/maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          // The link-preview card is only ever fetched by chat apps' crawlers —
          // keep it out of every user's precache.
          globIgnores: ['**/og/**'],
          navigateFallback: '/index.html',
          // Never let the SW intercept Supabase (auth/rest/realtime/storage) —
          // those must always hit the network for live truth.
          navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/realtime\//, /^\/storage\//],
          runtimeCaching: [
            {
              // Google Fonts stylesheet + files: stale-while-revalidate so the
              // shell renders with fonts offline after first load.
              urlPattern: ({ url }: { url: URL }) =>
                url.origin === 'https://fonts.googleapis.com' ||
                url.origin === 'https://fonts.gstatic.com',
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'google-fonts' },
            },
          ],
        },
        devOptions: {
          // Keep the SW out of `npm run dev` to avoid caching surprises while
          // developing; it is generated for the production build.
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: true,
      // Integration test files (*.integration.test.ts) mutate the ONE shared
      // local Supabase stack; running test files in parallel let them race
      // (e.g. close_season's global "active season" pick) → intermittent reds.
      // Serialize file execution so DB-touching files never overlap. Unit/RTL
      // files (jsdom, mocked supabase) are unaffected by the modest slowdown.
      fileParallelism: false,
      env: {
        SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
        // Opt-in flag for the realtime WS integration test (slice 11), which is
        // flaky under parallel Kong load so it stays out of the default gate.
        RUN_REALTIME_IT: env.RUN_REALTIME_IT ?? '',
      },
    },
  }
})
