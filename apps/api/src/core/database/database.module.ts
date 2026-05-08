import { Module, Global } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { db, dbAdmin } from '@flicks/db';

export const DB_TENANT = Symbol('DB_TENANT');
export const DB_SERVICE_ROLE = Symbol('DB_SERVICE_ROLE');

@Global()
@Module({
  providers: [
    {
      provide: DB_TENANT,
      useValue: db,
    },
    {
      provide: DB_SERVICE_ROLE,
      useValue: dbAdmin,
    },
    DatabaseService,
  ],
  exports: [DB_TENANT, DB_SERVICE_ROLE, DatabaseService],
})
export class DatabaseModule {}
