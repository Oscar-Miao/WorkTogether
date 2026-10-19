import { defineConfig } from 'tsup';
// Nest and native/storage dependencies stay external; workspace code forms one API bundle.
export default defineConfig({
  entry: ['apps/api/src/main.ts'],
  outDir: 'apps/api/dist',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  clean: true,
  tsconfig: 'tsconfig.build.json',
  noExternal: ['@team-agent/contracts', '@team-agent/domain', '@team-agent/database'],
  external: [
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/platform-express',
    'reflect-metadata',
    'rxjs',
    'cookie-parser',
    'ws',
    'jose',
    'express',
    '@electric-sql/pglite',
    'pg',
    '@node-rs/argon2',
  ],
});
