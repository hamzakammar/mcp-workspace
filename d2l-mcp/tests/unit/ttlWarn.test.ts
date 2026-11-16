import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/s3Storage.js', () => ({ getStorageStateCapturedAt: vi.fn(), STORAGE_STATE_MAX_AGE_DAYS: 25 }));
vi.mock('../../src/api/push.js', () => ({ sendPushToUser: vi.fn(async () => 0) }));
vi.mock('../../src/auth.js', () => ({ clearSessionValidation: vi.fn() }));

import { shouldWarnStorageStateAge, STORAGE_STATE_WARN_DAYS } from '../../src/jobs/storageStateTTL.js';

describe('shouldWarnStorageStateAge', () => {
  it('warns only during the one-day window starting at the warn threshold', () => {
    expect(STORAGE_STATE_WARN_DAYS).toBe(20);
    expect(shouldWarnStorageStateAge(19.9)).toBe(false);
    expect(shouldWarnStorageStateAge(20)).toBe(true);
    expect(shouldWarnStorageStateAge(20.9)).toBe(true);
    expect(shouldWarnStorageStateAge(21)).toBe(false);
    expect(shouldWarnStorageStateAge(26)).toBe(false);
  });
});
