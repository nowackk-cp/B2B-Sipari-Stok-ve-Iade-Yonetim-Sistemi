import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from '../../src/modules/auth/adapters/in-memory-rate-limiter';
import { FakeClock } from './_fakes';

describe('InMemoryRateLimiter', () => {
  it('allows up to the limit then blocks', async () => {
    const limiter = new InMemoryRateLimiter(new FakeClock());
    for (let i = 0; i < 3; i++) {
      expect((await limiter.hit('k', 3, 60)).allowed).toBe(true);
    }
    const blocked = await limiter.hit('k', 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reset() clears the counter', async () => {
    const limiter = new InMemoryRateLimiter(new FakeClock());
    await limiter.hit('k', 1, 60);
    expect((await limiter.hit('k', 1, 60)).allowed).toBe(false);
    await limiter.reset('k');
    expect((await limiter.hit('k', 1, 60)).allowed).toBe(true);
  });

  it('resets after the window elapses', async () => {
    const clock = new FakeClock();
    const limiter = new InMemoryRateLimiter(clock);
    await limiter.hit('k', 1, 60);
    expect((await limiter.hit('k', 1, 60)).allowed).toBe(false);
    clock.advanceMs(61_000);
    expect((await limiter.hit('k', 1, 60)).allowed).toBe(true);
  });

  it('tracks keys independently', async () => {
    const limiter = new InMemoryRateLimiter(new FakeClock());
    await limiter.hit('a', 1, 60);
    expect((await limiter.hit('a', 1, 60)).allowed).toBe(false);
    expect((await limiter.hit('b', 1, 60)).allowed).toBe(true);
  });
});
