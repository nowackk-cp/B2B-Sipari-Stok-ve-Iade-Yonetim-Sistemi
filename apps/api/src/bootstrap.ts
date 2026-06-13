import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { API_DOCS_PATH, API_GLOBAL_PREFIX } from '@b2b/shared';
import type { AppConfigService } from './common/config/app-config.service';
import { APP_VERSION, SERVICE_NAME } from './app.constants';

/**
 * Apply the cross-cutting HTTP configuration shared by the runtime server, the
 * integration tests and the OpenAPI generator: global prefix, strict
 * validation pipe, and CORS.
 *
 * The global RFC 7807 exception filter and request-id middleware are wired in
 * {@link AppModule}, so they apply automatically here too.
 */
export function configureApp(app: INestApplication, config: AppConfigService): void {
  app.setGlobalPrefix(API_GLOBAL_PREFIX);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });

  // Hooks for graceful shutdown (SIGTERM/SIGINT → onModuleDestroy/onApplicationShutdown).
  app.enableShutdownHooks();
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('B2B Operations Suite API')
    .setDescription('REST API for the B2B Operations Suite (foundation).')
    .setVersion(APP_VERSION)
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, builder);
}

export function setupSwagger(app: INestApplication): void {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup(API_DOCS_PATH, app, document, {
    customSiteTitle: `${SERVICE_NAME} · API docs`,
  });
}
