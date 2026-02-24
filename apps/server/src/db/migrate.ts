import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { closeDbPool, withDbClient } from './client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationsDir = path.join(__dirname, 'migrations');

const ensureMigrationsTable = async (): Promise<void> => {
  await withDbClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id bigserial PRIMARY KEY,
        filename text UNIQUE NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT NOW()
      );
    `);
  });
};

const run = async (): Promise<void> => {
  await ensureMigrationsTable();

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  await withDbClient(async (client) => {
    for (const file of files) {
      const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        // eslint-disable-next-line no-console
        console.log(`applied migration: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  });
};

void run()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('migration failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
