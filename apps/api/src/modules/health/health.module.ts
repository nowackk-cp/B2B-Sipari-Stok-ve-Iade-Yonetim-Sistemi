import { Module } from '@nestjs/common';
import { HEALTH_INDICATORS } from '../../app.constants';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { SelfHealthIndicator } from './indicators/self.indicator';
import type { HealthIndicator } from './health-indicator';

/**
 * Health module. Readiness indicators are aggregated from
 * {@link HEALTH_INDICATORS}; register additional indicators (DB, Redis,
 * storage) here as those dependencies are wired up.
 */
@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    SelfHealthIndicator,
    {
      provide: HEALTH_INDICATORS,
      useFactory: (self: SelfHealthIndicator): HealthIndicator[] => [self],
      inject: [SelfHealthIndicator],
    },
  ],
})
export class HealthModule {}
