import { Module, Global, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Injectable ioredis singleton (PRD v4 §5.2 — presence liveness store).
 * Connects with the same REDIS_* env the BullMQ root config uses, so it adds
 * no new infrastructure requirement. lazyConnect + bounded retries keep a
 * Redis outage from hanging requests — callers degrade gracefully instead.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        // Never let a Redis blip hang a request: fail fast, callers catch.
        const opts = { maxRetriesPerRequest: 1, lazyConnect: true };
        // REDIS_URL wins when set (Railway/Upstash; rediss:// = TLS). ioredis
        // merges the second-arg options over the parsed URL.
        const url = config.get<string>('REDIS_URL');
        const client = url
          ? new Redis(url, opts)
          : new Redis({
              host: config.get<string>('REDIS_HOST', 'localhost'),
              port: config.get<number>('REDIS_PORT', 6379),
              password: config.get<string>('REDIS_PASSWORD'),
              ...opts,
            });
        const logger = new Logger('Redis');
        client.on('error', (err) => logger.warn(`redis error: ${err.message}`));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
