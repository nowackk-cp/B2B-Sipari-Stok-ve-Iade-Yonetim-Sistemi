import { Injectable } from '@nestjs/common';
import type { ComponentHealth } from '@b2b/shared';
import type { HealthIndicator } from '../health-indicator';

/** Trivially-passing indicator proving the process can serve requests. */
@Injectable()
export class SelfHealthIndicator implements HealthIndicator {
  readonly name = 'self';

  check(): ComponentHealth {
    return { status: 'ok' };
  }
}
