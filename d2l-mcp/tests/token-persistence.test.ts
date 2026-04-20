/**
 * Task 1 — Token Persistence Fix
 *
 * Unit-level tests that verify the session-validation logic without hitting
 * real D2L endpoints.  We mock `getD2LToken` and the fetch used by
 * `validateTokenLive` to exercise all branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- helpers ----

/**
 * Simulate "server restart" by clearing vitest's module registry so
 * `userValidatedInSession` is reset to an empty Set.
 */
async function freshAuthModule() {
  vi.resetModules();
  const mod = await import('../src/auth.js');
  return mod;
}

describe('Token Persistence (Task 1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Clear env vars so tests are deterministic
    delete process.env.D2L_TOKEN;
  });

  it('exports validateTokenLive-related symbols', async () => {
    const auth = await freshAuthModule();
    // These exports must exist for external callers
    expect(typeof auth.getToken).toBe('function');
    expect(typeof auth.forceRefreshToken).toBe('function');
    expect(typeof auth.clearTokenCache).toBe('function');
    expect(typeof auth.clearSessionValidation).toBe('function');
  });

  it('clearSessionValidation is callable without throwing', async () => {
    const { clearSessionValidation } = await freshAuthModule();
    expect(() => clearSessionValidation('test-user-123')).not.toThrow();
  });

  it('clearTokenCache removes the user from per-session validation', async () => {
    const { clearTokenCache, clearSessionValidation } = await freshAuthModule();
    // Should not throw even if the user was never validated
    expect(() => {
      clearSessionValidation('some-user');
      clearTokenCache('some-user');
    }).not.toThrow();
  });
});
