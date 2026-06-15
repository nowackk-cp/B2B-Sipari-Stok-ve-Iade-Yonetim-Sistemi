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

  // --- mail (outbound SMTP) --------------------------------------------------
  /** SMTP transport settings for the real mail provider. `user`/`password` are
   * undefined for an unauthenticated dev relay (Mailpit); production validation
   * makes them mandatory ({@link requireProductionMail}). */
  get mail(): {
    host: string;
    port: number;
    secure: boolean;
    user: string | undefined;
    password: string | undefined;
    from: string;
  } {
    return {
      host: this.config.SMTP_HOST,
      port: this.config.SMTP_PORT,
      secure: this.config.SMTP_SECURE,
      user: this.config.SMTP_USER,
      password: this.config.SMTP_PASSWORD,
      from: this.config.MAIL_FROM,
    };
  }

  /** Base URL the password-reset link points at (the browser app origin). Derived
   * from the first configured CORS origin; the raw token is appended only in
   * memory while the email body is built, never here. */
  get passwordResetLinkBase(): string {
    const origin = this.config.API_CORS_ORIGINS[0] ?? 'http://localhost:3000';
    return `${origin.replace(/\/+$/, '')}/reset-password`;
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

  /** Env-only AES-256-GCM key material for the deliverable reset token (never
   * persisted; the cipher derives a fixed 256-bit key from it at boot). */
  get passwordResetDeliveryKey(): string {
    return this.config.PASSWORD_RESET_DELIVERY_KEY;
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
