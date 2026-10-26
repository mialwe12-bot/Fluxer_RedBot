import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests importieren reine Hilfsfunktionen direkt aus Cogs; diese nutzen das SDK-Alias.
    alias: { '@bot/sdk': fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    globalSetup: ['tests/globalSetup.ts'],
    env: { TZ: 'Europe/Berlin' },
  },
});
