import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**/*.test.ts'],
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['d2l-mcp/src/**/*.ts'],
      exclude: ['d2l-mcp/src/index.ts', 'd2l-mcp/src/auth.ts', 'd2l-mcp/src/auth-cli.ts'],
    },
  },
});
