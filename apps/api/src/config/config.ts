import { existsSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
export interface ApiConfig {
  projectRoot: string;
  dataDir: string;
  databaseUrl?: string;
  databaseSchema?: string;
  host: string;
  port: number;
  webOrigin: string;
  production: boolean;
  ownerEmail: string;
  ownerPassword?: string;
  retentionEnabled: boolean;
}
export function readConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  const projectRoot = resolve(process.cwd());
  const envFile = resolve(projectRoot, '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const production = process.env.NODE_ENV === 'production';
  const config: ApiConfig = {
    projectRoot,
    dataDir: resolve(projectRoot, process.env.TEAM_AGENT_SERVER_DATA_DIR || '.local/server'),
    databaseUrl: process.env.DATABASE_URL || undefined,
    host: process.env.API_HOST || '127.0.0.1',
    port: Number(process.env.API_PORT || 3001),
    webOrigin: process.env.WEB_ORIGIN || 'http://127.0.0.1:5173',
    production,
    ownerEmail: process.env.OWNER_EMAIL || 'owner@team.local',
    ownerPassword: process.env.OWNER_PASSWORD,
    retentionEnabled: process.env.TEAM_AGENT_RETENTION_ENABLED === 'true',
    ...overrides,
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error('Invalid API_PORT');
  if (
    production &&
    (!config.databaseUrl ||
      !config.webOrigin.startsWith('https://') ||
      !isAbsolute(process.env.TEAM_AGENT_SERVER_DATA_DIR || ''))
  )
    throw new Error('Production requires PostgreSQL, HTTPS origin and an absolute data directory');
  mkdirSync(config.dataDir, { recursive: true });
  return config;
}
