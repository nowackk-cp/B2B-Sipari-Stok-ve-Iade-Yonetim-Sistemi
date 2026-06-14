import { Inject, Injectable } from '@nestjs/common';
import type { ComponentHealth, HealthState, HealthStatus } from '@b2b/contracts';
import { APP_VERSION, HEALTH_INDICATORS, SERVICE_NAME } from '../../app.constants';
import { AppConfigService } from '../../common/config/app-config.service';
import type { HealthIndicator } from './health-indicator';

@Injectable()
export class HealthService {
  constructor(
    private readonly config: AppConfigService,
    @Inject(HEALTH_INDICATORS) private readonly indicators: HealthIndicator[],
  ) {}

  private base(status: HealthState): HealthStatus {
    return {
      status,
      service: SERVICE_NAME,
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      environment: this.config.nodeEnv,
    };
  }

  /** Liveness: the process is up and able to respond. */
  getLiveness(): HealthStatus {
    return this.base('ok');
  }

  /** Readiness: aggregate all registered dependency indicators. */
  async getReadiness(): Promise<HealthStatus> {
    const details: Record<string, ComponentHealth> = {};
    let worst: HealthState = 'ok';

    for (const indicator of this.indicators) {
      const result = await this.runIndicator(indicator);
      details[indicator.name] = result;
      worst = reduceState(worst, result.status);
    }

    return { ...this.base(worst), details };
  }

  private async runIndicator(indicator: HealthIndicator): Promise<ComponentHealth> {
    try {
      return await indicator.check();
    } catch (err) {
      return { status: 'error', detail: err instanceof Error ? err.message : 'check failed' };
    }
  }
}

const SEVERITY: Record<HealthState, number> = { ok: 0, degraded: 1, error: 2 };

function reduceState(current: HealthState, next: HealthState): HealthState {
  return SEVERITY[next] > SEVERITY[current] ? next : current;
}
