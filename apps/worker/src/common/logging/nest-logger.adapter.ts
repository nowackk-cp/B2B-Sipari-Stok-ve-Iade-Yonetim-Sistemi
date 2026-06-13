import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@b2b/logger';

/** Routes NestJS framework logs through the shared pino logger. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private static text(message: unknown): string {
    return typeof message === 'string' ? message : JSON.stringify(message);
  }

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, PinoNestLogger.text(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, PinoNestLogger.text(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, PinoNestLogger.text(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, PinoNestLogger.text(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, PinoNestLogger.text(message));
  }
}
