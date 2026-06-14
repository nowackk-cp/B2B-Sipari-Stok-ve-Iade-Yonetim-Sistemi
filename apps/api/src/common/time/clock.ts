import { Injectable } from '@nestjs/common';

/** DI token for the {@link Clock} abstraction. */
export const CLOCK = Symbol('CLOCK');

/**
 * Time source abstraction so token expiry, lockout windows and "now"-dependent
 * logic are deterministically testable (no `new Date()` scattered in services).
 */
export interface Clock {
  now(): Date;
}

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
