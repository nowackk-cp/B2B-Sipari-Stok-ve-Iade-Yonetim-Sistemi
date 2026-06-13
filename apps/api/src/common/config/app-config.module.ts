import { Global, Module } from '@nestjs/common';
import { loadApiConfig } from '@b2b/config';
import { API_CONFIG } from '../../app.constants';
import { AppConfigService } from './app-config.service';

/**
 * Loads and validates the API environment once at boot (fail-fast).
 * Exposes the typed config via {@link AppConfigService}.
 */
@Global()
@Module({
  providers: [
    {
      provide: API_CONFIG,
      useFactory: () => loadApiConfig(),
    },
    AppConfigService,
  ],
  exports: [API_CONFIG, AppConfigService],
})
export class AppConfigModule {}
