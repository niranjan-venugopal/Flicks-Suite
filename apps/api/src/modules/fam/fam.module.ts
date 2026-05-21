import { Module } from '@nestjs/common';
import { FamController } from './fam.controller';
import { FamService } from './fam.service';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [FamController],
  providers: [FamService],
  exports: [FamService],
})
export class FamModule {}
