import { defineConfig } from 'drizzle-kit';

if (!process.env['DATABASE_DIRECT_URL']) {
  throw new Error('DATABASE_DIRECT_URL environment variable is required');
}

export default defineConfig({
  dialect: 'postgresql',
  driver: 'postgres-js',
  schema: './src/schema/*.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_DIRECT_URL'],
  },
  verbose: true,
  strict: true,
});
