import { Global, Module } from '@nestjs/common';
import { AuditWriter } from './audit-writer.service';

/** Global transactional business-audit writer (ADR-007). */
@Global()
@Module({
  providers: [AuditWriter],
  exports: [AuditWriter],
})
export class AuditModule {}
