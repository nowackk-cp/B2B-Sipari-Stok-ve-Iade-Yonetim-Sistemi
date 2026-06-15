import { Body, Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { IsString } from 'class-validator';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/common/config/app-config.service';
import { Public } from '../../src/common/auth/public.decorator';
import { configureApp } from '../../src/bootstrap';

/**
 * Test-only DTO + controller. These exist ONLY inside this integration test so
 * the global ValidationPipe (whitelist + forbidNonWhitelisted) and the RFC 7807
 * filter can be exercised against a real request without adding any probe
 * endpoint to the production module surface. Marked `@Public()` so the global
 * authentication guard does not require a token before the pipe/filter run.
 */
class ProbeDto {
  @IsString()
  name!: string;
}

@Public()
@Controller()
class ValidationProbeController {
  @Post('validation-probe')
  create(@Body() dto: ProbeDto): { ok: true; name: string } {
    return { ok: true, name: dto.name };
  }

  @Get('boom-probe')
  boom(): never {
    throw new Error('secret internal failure detail');
  }
}

describe('global ValidationPipe + RFC 7807 (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ValidationProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(AppConfigService));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a valid DTO', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/validation-probe')
      .send({ name: 'widget' })
      .expect(201);
    expect(res.body).toEqual({ ok: true, name: 'widget' });
  });

  it('rejects an unknown extra field with 400 problem+json (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/validation-probe')
      .send({ name: 'widget', injected: 'should-not-pass' })
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      instance: '/api/v1/validation-probe',
    });
    expect(typeof res.body.type).toBe('string');
    expect(typeof res.body.title).toBe('string');
    expect(typeof res.body.detail).toBe('string');
    expect(res.body.requestId).toBeTruthy();
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing required field with 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/validation-probe')
      .send({})
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('maps an unexpected 500 to a safe problem document with no internal leak', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/boom-probe').expect(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      status: 500,
      code: 'INTERNAL',
      title: 'Internal Server Error',
      detail: 'An unexpected error occurred.',
    });
    expect(res.body.requestId).toBeTruthy();
    // The internal error message and any stack must never be exposed.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('secret internal failure detail');
    expect(serialized).not.toContain('at ');
    expect(res.body.stack).toBeUndefined();
  });
});
