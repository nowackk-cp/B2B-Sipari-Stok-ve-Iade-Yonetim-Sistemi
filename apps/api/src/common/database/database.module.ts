import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Global access to the shared Prisma client + transaction helper. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
