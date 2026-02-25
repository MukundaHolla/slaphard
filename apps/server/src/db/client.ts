import { Pool, type PoolClient } from 'pg';
import { config } from '../runtime-config';

let pool: Pool | null = null;

export const getDbPool = (): Pool => {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required for DB persistence');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }

  return pool;
};

export const withDbClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await getDbPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
};

export const closeDbPool = async (): Promise<void> => {
  if (!pool) {
    return;
  }
  await pool.end();
  pool = null;
};
