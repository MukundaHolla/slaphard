import { closeDbPool, withDbClient } from './client';

const run = async (): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset is disabled in production');
  }

  await withDbClient(async (client) => {
    await client.query(`
      DROP TABLE IF EXISTS match_events;
      DROP TABLE IF EXISTS matches;
      DROP TABLE IF EXISTS room_snapshots;
      DROP TABLE IF EXISTS rooms;
      DROP TABLE IF EXISTS schema_migrations;
    `);
  });

  // eslint-disable-next-line no-console
  console.log('database schema reset complete');
};

void run()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('db reset failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
