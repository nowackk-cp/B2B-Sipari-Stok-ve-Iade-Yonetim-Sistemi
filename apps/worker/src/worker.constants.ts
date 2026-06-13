/** Logical service name used in logs. */
export const SERVICE_NAME = 'worker';

/** Worker version, surfaced in the readiness log. */
export const APP_VERSION = process.env.npm_package_version ?? '0.0.0';

/** DI token for the shared pino logger instance. */
export const WORKER_LOGGER = Symbol('WORKER_LOGGER');

/** DI token for the validated worker configuration. */
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

/** DI token for the resolved worker instance identity. */
export const WORKER_IDENTITY = Symbol('WORKER_IDENTITY');

/** DI token for the shared ioredis connection. */
export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');
