import { Module } from '@nestjs/common';
import { FamController } from './fam.controller';
import { FamService } from './fam.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [FamController],
  providers: [FamService],
  exports: [FamService],
})
export class FamModule {}
