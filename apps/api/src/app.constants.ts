/** Logical service name used in logs and the health payload. */
export const SERVICE_NAME = 'api';

/** Application version, surfaced by the health endpoint. */
export const APP_VERSION = process.env.npm_package_version ?? '0.0.0';

/** DI token for the shared pino logger instance. */
export const APP_LOGGER = Symbol('APP_LOGGER');

/** DI token for the validated API configuration. */
export const API_CONFIG = Symbol('API_CONFIG');

/** DI token for the registered readiness health indicators. */
export const HEALTH_INDICATORS = Symbol('HEALTH_INDICATORS');
