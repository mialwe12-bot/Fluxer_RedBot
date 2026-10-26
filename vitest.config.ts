import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    globalSetup: ['tests/globalSetup.ts'],
    env: { TZ: 'Europe/Berlin' },
  },
});
