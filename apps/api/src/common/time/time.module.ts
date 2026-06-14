import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from './clock';

/** Global clock provider; overridden with a fake clock in unit tests. */
@Global()
@Module({
  providers: [{ provide: CLOCK, useClass: SystemClock }],
  exports: [CLOCK],
})
export class TimeModule {}
