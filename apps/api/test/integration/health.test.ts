import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@b2b/contracts';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/common/config/app-config.service';
import { configureApp } from '../../src/bootstrap';

describe('API foundation (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(AppConfigService));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('health', () => {
    it('GET /api/v1/health returns service/version/timestamp/environment', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        service: 'api',
        environment: 'test',
      });
      expect(typeof res.body.version).toBe('string');
      expect(typeof res.body.timestamp).toBe('string');
      expect(() => new Date(res.body.timestamp).toISOString()).not.toThrow();
    });

    it('GET /api/v1/health/live returns liveness', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /api/v1/health/ready aggregates dependency indicators', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.details).toMatchObject({ self: { status: 'ok' } });
    });
  });

  describe('RFC 7807 errors', () => {
    it('returns problem+json for an unknown route', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
        instance: '/api/v1/does-not-exist',
      });
      expect(typeof res.body.type).toBe('string');
      expect(typeof res.body.title).toBe('string');
      expect(res.body.requestId).toBeTruthy();
      // No stack trace must leak.
      expect(JSON.stringify(res.body)).not.toContain('at ');
      expect(res.body.stack).toBeUndefined();
    });
  });

  describe('request id propagation', () => {
    it('echoes a client-provided X-Request-Id', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set(REQUEST_ID_HEADER, 'client-req-123')
        .expect(200);
      expect(res.headers[REQUEST_ID_HEADER]).toBe('client-req-123');
    });

    it('generates an X-Request-Id when none is provided', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      const generated = res.headers[REQUEST_ID_HEADER];
      expect(generated).toBeTruthy();
      expect(String(generated).length).toBeGreaterThan(0);
    });

    it('surfaces the generated requestId inside error responses', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/missing')
        .set(REQUEST_ID_HEADER, 'err-trace-9')
        .expect(404);
      expect(res.body.requestId).toBe('err-trace-9');
      expect(res.headers[REQUEST_ID_HEADER]).toBe('err-trace-9');
    });
  });
});
