import { z } from 'zod';

const rawEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  REDIS_URL: z.string().trim().min(1).optional(),
  DATABASE_URL: z.string().trim().min(1).optional(),
  ENABLE_DB_PERSISTENCE: z.enum(['true', 'false', '1', '0']).default('true'),
  ALLOW_IN_MEMORY_ROOM_STORE: z.enum(['true', 'false', '1', '0']).default('false'),
  CORS_ORIGINS: z.string().optional(),
  NODE_ENV: z.string().default('development'),
});

const asBoolean = (value: 'true' | 'false' | '1' | '0'): boolean => value === 'true' || value === '1';

const parseOrigin = (value: string): string => {
  if (value === '*') {
    throw new Error('CORS_ORIGINS must not contain "*"');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid CORS origin: ${value}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`invalid CORS origin protocol: ${value}`);
  }

  return `${parsed.protocol}//${parsed.host}`;
};

const parseCorsOrigins = (corsOriginsEnv: string | undefined, isProduction: boolean): string[] => {
  if (!corsOriginsEnv || corsOriginsEnv.trim().length === 0) {
    if (isProduction) {
      throw new Error('CORS_ORIGINS is required in production');
    }
    return ['http://localhost:5173', 'http://127.0.0.1:5173'];
  }

  const origins = corsOriginsEnv
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map(parseOrigin);

  if (origins.length === 0) {
    if (isProduction) {
      throw new Error('CORS_ORIGINS must include at least one origin in production');
    }
    return ['http://localhost:5173', 'http://127.0.0.1:5173'];
  }

  return [...new Set(origins)];
};

export interface AppConfig {
  port: number;
  redisUrl: string | undefined;
  databaseUrl: string | undefined;
  enableDbPersistence: boolean;
  allowInMemoryRoomStore: boolean;
  nodeEnv: string;
  isProduction: boolean;
  corsOrigins: string[];
}

export const parseConfigFromEnv = (env: NodeJS.ProcessEnv): AppConfig => {
  const raw = rawEnvSchema.parse(env);
  const enableDbPersistence = asBoolean(raw.ENABLE_DB_PERSISTENCE);
  const allowInMemoryRoomStore = asBoolean(raw.ALLOW_IN_MEMORY_ROOM_STORE);
  const isProduction = raw.NODE_ENV === 'production';

  if (!raw.REDIS_URL && !allowInMemoryRoomStore) {
    throw new Error('REDIS_URL is required unless ALLOW_IN_MEMORY_ROOM_STORE=true');
  }

  if (enableDbPersistence && !raw.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when ENABLE_DB_PERSISTENCE=true');
  }

  return {
    port: raw.PORT,
    redisUrl: raw.REDIS_URL,
    databaseUrl: raw.DATABASE_URL,
    enableDbPersistence,
    allowInMemoryRoomStore,
    nodeEnv: raw.NODE_ENV,
    isProduction,
    corsOrigins: parseCorsOrigins(raw.CORS_ORIGINS, isProduction),
  };
};
