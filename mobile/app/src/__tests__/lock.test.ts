import { INACTIVITY_LOCK_MS } from '../lib/config';
import { isInactive, shouldCoverContent, statusOnResume, statusOnStart, statusOnTick } from '../lib/lock';

describe('правила блокування п.2.9', () => {
  const t0 = 1_000_000;

  test('холодний старт із сесією і PIN — завжди заблоковано', () => {
    expect(statusOnStart(true, true)).toBe('locked');
    expect(statusOnStart(true, false)).toBe('needsPin');
    expect(statusOnStart(false, true)).toBe('signedOut');
  });

  test('5 хвилин без дій — блокування, раніше — ні', () => {
    expect(isInactive(t0, t0 + INACTIVITY_LOCK_MS - 1)).toBe(false);
    expect(isInactive(t0, t0 + INACTIVITY_LOCK_MS)).toBe(true);
    expect(statusOnTick('unlocked', t0, t0 + INACTIVITY_LOCK_MS)).toBe('locked');
    expect(statusOnTick('unlocked', t0, t0 + 1000)).toBe('unlocked');
  });

  test('повернення з фону рахує час від останньої дії', () => {
    expect(statusOnResume('unlocked', t0, t0 + 6 * 60 * 1000)).toBe('locked');
    expect(statusOnResume('unlocked', t0, t0 + 60 * 1000)).toBe('unlocked');
    expect(statusOnResume('signedOut', t0, t0 + 60 * 60 * 1000)).toBe('signedOut');
  });

  test('вміст приховується у фоні та при блокуванні', () => {
    expect(shouldCoverContent('background', 'unlocked')).toBe(true);
    expect(shouldCoverContent('inactive', 'unlocked')).toBe(true);
    expect(shouldCoverContent('active', 'unlocked')).toBe(false);
    expect(shouldCoverContent('active', 'locked')).toBe(true);
    expect(shouldCoverContent('background', 'signedOut')).toBe(false);
  });
});
