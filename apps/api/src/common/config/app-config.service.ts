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

  get redisUrl(): string {
    return this.config.REDIS_URL;
  }

  get swaggerEnabled(): boolean {
    return this.config.SWAGGER_ENABLED;
  }

  // --- auth: access token ----------------------------------------------------
  get jwtAccessSecret(): string {
    return this.config.JWT_ACCESS_SECRET;
  }

  get jwtAccessTtlSeconds(): number {
    return this.config.JWT_ACCESS_TTL_SECONDS;
  }

  get jwtIssuer(): string {
    return this.config.JWT_ISSUER;
  }

  get jwtAudience(): string {
    return this.config.JWT_AUDIENCE;
  }

  // --- auth: refresh token ---------------------------------------------------
  get refreshTokenTtlDays(): number {
    return this.config.REFRESH_TOKEN_TTL_DAYS;
  }

  // --- auth: argon2id parameters ---------------------------------------------
  get argon2(): { memoryKiB: number; iterations: number; parallelism: number } {
    return {
      memoryKiB: this.config.ARGON2_MEMORY_KIB,
      iterations: this.config.ARGON2_ITERATIONS,
      parallelism: this.config.ARGON2_PARALLELISM,
    };
  }

  // --- auth: password reset --------------------------------------------------
  get passwordResetTtlMinutes(): number {
    return this.config.PASSWORD_RESET_TTL_MINUTES;
  }

  // --- auth: durable account lockout -----------------------------------------
  get lockout(): { threshold: number; durationMinutes: number } {
    return {
      threshold: this.config.AUTH_LOCKOUT_THRESHOLD,
      durationMinutes: this.config.AUTH_LOCKOUT_DURATION_MINUTES,
    };
  }

  // --- auth: login rate limit ------------------------------------------------
  get loginRateLimit(): { max: number; windowSeconds: number } {
    return {
      max: this.config.LOGIN_RATE_LIMIT_MAX,
      windowSeconds: this.config.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    };
  }

  // --- auth: refresh cookie --------------------------------------------------
  get refreshCookie(): {
    name: string;
    path: string;
    secure: boolean;
    domain: string | undefined;
    /** Cookie Max-Age in seconds, matching the refresh-token TTL. */
    maxAgeSeconds: number;
  } {
    return {
      name: this.config.REFRESH_COOKIE_NAME,
      path: this.config.REFRESH_COOKIE_PATH,
      // Secure defaults to true in production unless explicitly overridden.
      secure: this.config.COOKIE_SECURE ?? this.isProduction,
      domain: this.config.COOKIE_DOMAIN,
      maxAgeSeconds: this.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    };
  }
}
