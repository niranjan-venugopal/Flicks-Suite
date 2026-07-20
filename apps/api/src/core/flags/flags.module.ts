import { Global, Module } from '@nestjs/common';
import { FlagEvalService } from './flag-eval.service';

/**
 * Global runtime feature-flag evaluation (FAM `feature_flags` table).
 * Global so /me (auth) and any module can consume effective flags without
 * import cycles — the evaluator is read-only + cached.
 */
@Global()
@Module({
  providers: [FlagEvalService],
  exports: [FlagEvalService],
})
export class FlagsModule {}
