import { describe, expect, it } from 'vitest';
import { parseConfigFromEnv } from '../../src/config';

const baseEnv = (): NodeJS.ProcessEnv => ({
  PORT: '3001',
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/slaphard',
  ENABLE_DB_PERSISTENCE: 'true',
  ALLOW_IN_MEMORY_ROOM_STORE: 'false',
  NODE_ENV: 'development',
});

describe('parseConfigFromEnv', () => {
  it('uses safe localhost CORS defaults in non-production when CORS_ORIGINS is missing', () => {
    const config = parseConfigFromEnv(baseEnv());
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('fails in production when CORS_ORIGINS is missing', () => {
    const env = baseEnv();
    env.NODE_ENV = 'production';

    expect(() => parseConfigFromEnv(env)).toThrow('CORS_ORIGINS is required in production');
  });

  it('fails when REDIS_URL is missing and in-memory fallback is disabled', () => {
    const env = baseEnv();
    delete env.REDIS_URL;

    expect(() => parseConfigFromEnv(env)).toThrow(
      'REDIS_URL is required unless ALLOW_IN_MEMORY_ROOM_STORE=true',
    );
  });

  it('allows missing REDIS_URL only when in-memory fallback is enabled', () => {
    const env = baseEnv();
    delete env.REDIS_URL;
    env.ALLOW_IN_MEMORY_ROOM_STORE = 'true';

    const config = parseConfigFromEnv(env);
    expect(config.allowInMemoryRoomStore).toBe(true);
    expect(config.redisUrl).toBeUndefined();
  });

  it('fails when DB persistence is enabled and DATABASE_URL is missing', () => {
    const env = baseEnv();
    delete env.DATABASE_URL;

    expect(() => parseConfigFromEnv(env)).toThrow(
      'DATABASE_URL is required when ENABLE_DB_PERSISTENCE=true',
    );
  });

  it('accepts and normalizes configured CORS_ORIGINS', () => {
    const env = baseEnv();
    env.CORS_ORIGINS = 'https://example.com/, https://api.example.com:8443, https://example.com';

    const config = parseConfigFromEnv(env);
    expect(config.corsOrigins).toEqual(['https://example.com', 'https://api.example.com:8443']);
  });
});
