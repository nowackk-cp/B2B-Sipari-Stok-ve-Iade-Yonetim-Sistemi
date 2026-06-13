import { ApiProperty } from '@nestjs/swagger';
import type { ComponentHealth, HealthState, HealthStatus } from '@b2b/shared';

/** Swagger view-model for the health payload (documentation only). */
export class HealthStatusDto implements HealthStatus {
  @ApiProperty({ enum: ['ok', 'degraded', 'error'], example: 'ok' })
  status!: HealthState;

  @ApiProperty({ example: 'api' })
  service!: string;

  @ApiProperty({ example: '0.0.0' })
  version!: string;

  @ApiProperty({ example: '2026-06-13T10:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ example: 'development' })
  environment!: string;

  @ApiProperty({
    required: false,
    description: 'Per-dependency readiness detail.',
    additionalProperties: { type: 'object' },
  })
  details?: Record<string, ComponentHealth>;
}
