import { Global, Module } from '@nestjs/common';
import { ModuleAccessService } from './module-access.service';

/**
 * Global module-access resolution (membership grants + tenant role defaults).
 * Global for the same reason FlagsModule is: the guards, /me and Settings all
 * need it, and routing it through AuthModule/MembersModule would create an
 * import cycle. The service depends on DatabaseService only.
 */
@Global()
@Module({
  providers: [ModuleAccessService],
  exports: [ModuleAccessService],
})
export class ModuleAccessModule {}
