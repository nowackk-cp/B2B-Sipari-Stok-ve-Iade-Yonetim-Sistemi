import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { HealthStatus } from '@b2b/contracts';
import { HealthStatusDto } from './health.dto';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Overall health (alias of liveness) — `GET /api/v1/health`. */
  @Get()
  @ApiOkResponse({ type: HealthStatusDto })
  getHealth(): HealthStatus {
    return this.health.getLiveness();
  }

  /** Liveness probe — `GET /api/v1/health/live`. */
  @Get('live')
  @ApiOkResponse({ type: HealthStatusDto })
  getLiveness(): HealthStatus {
    return this.health.getLiveness();
  }

  /** Readiness probe — `GET /api/v1/health/ready` (503 when a dependency is down). */
  @Get('ready')
  @ApiOkResponse({ type: HealthStatusDto })
  @ApiServiceUnavailableResponse({ description: 'A dependency is not ready.' })
  async getReadiness(@Res({ passthrough: true }) res: Response): Promise<HealthStatus> {
    const status = await this.health.getReadiness();
    if (status.status === 'error') {
      res.status(503);
    }
    return status;
  }
}
