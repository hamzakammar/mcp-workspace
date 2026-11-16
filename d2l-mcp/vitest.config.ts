import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Live D2L integration tests run via vitest.integration.config.ts
    // (they also self-skip unless D2L_INTEGRATION_TESTS=true).
    exclude: ['**/node_modules/**', 'tests/**/*.integration.test.ts'],
    globals: false,
    environment: 'node',
    // Supabase client modules throw at import time without these; provide
    // harmless defaults so unit tests run without a real environment.
    env: {
      SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://localhost:54321',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-dummy',
    },
  },
});
