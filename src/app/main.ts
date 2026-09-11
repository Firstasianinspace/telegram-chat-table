import { createApp } from 'vue'
import App from '../App.vue'
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';
import { router } from './router';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { i18n } from '@/core/config/i18n';
import 'primeicons/primeicons.css';

// 1. Tailwind & Base styles first
import '@/shared/assets/sakai/tailwind.css';

// 2. Sakai layout SCSS (uses Tailwind utilities)
import '@/shared/assets/sakai/layout/layout.scss';

// 3. Default styles
import '@/assets/main.scss'

import { initializeChatStorage } from '@/modules/chat/infrastructure/chatStorageBootstrap';
import { installE2ETestHooks } from './e2eTestHooks';
import {
  CHAT_REPOSITORY_KEY,
  CHAT_ANALYTICS_REPOSITORY_KEY,
  CHAT_QUERY_STRATEGY_KEY,
} from '@/modules/chat/application/chatRepositorySymbol';

const app = createApp(App);
const pinia = createPinia();

// Initialize TanStack Query
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes (formerly cacheTime)
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Picks SQLite+OPFS when cross-origin isolation is available (see
// vite.config.ts / vercel.json headers), falling back to the legacy
// IndexedDB repositories otherwise. Runs the one-time IndexedDB -> SQLite
// migration when applicable — see chatStorageBootstrap.ts.
const storage = await initializeChatStorage();
if (import.meta.env.DEV) {
  console.log(`[chat-analyzer] storage backend: ${storage.backend}`);
}
installE2ETestHooks(storage.chatRepository);

app.use(pinia);
app.provide(CHAT_REPOSITORY_KEY, storage.chatRepository);
app.provide(CHAT_ANALYTICS_REPOSITORY_KEY, storage.analyticsRepository);
app.provide(CHAT_QUERY_STRATEGY_KEY, storage.queryStrategy);
app.use(VueQueryPlugin, { queryClient });
app.use(router);
app.use(i18n);

app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: '.dark-mode-disabled'
    }
  }
});
app.use(ToastService);
app.use(ConfirmationService);

app.mount('#app');
