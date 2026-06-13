import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@b2b/config';
import { API_CONFIG } from '../../app.constants';

/** Typed accessor over the validated API configuration. */
@Injectable()
export class AppConfigService {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  get raw(): ApiConfig {
    return this.config;
  }

  get nodeEnv(): ApiConfig['NODE_ENV'] {
    return this.config.NODE_ENV;
  }

  get isProduction(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  get logLevel(): ApiConfig['LOG_LEVEL'] {
    return this.config.LOG_LEVEL;
  }

  get port(): number {
    return this.config.API_PORT;
  }

  get corsOrigins(): string[] {
    return this.config.API_CORS_ORIGINS;
  }

  get swaggerEnabled(): boolean {
    return this.config.SWAGGER_ENABLED;
  }
}
