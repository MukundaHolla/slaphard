import Fastify from 'fastify';
import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { closeDbPool } from './db/client';
import { NoopPersistenceRepository, PostgresPersistenceRepository } from './db/postgres';
import { logger } from './logger';
import { GameService } from './service/game-service';
import { InMemoryRoomStore } from './store/in-memory-room-store';
import { RedisRoomStore } from './store/redis-room-store';
import { attachSocketHandlers } from './socket';

const app = Fastify({ loggerInstance: logger });

const roomStore = (() => {
  if (!config.redisUrl) {
    if (!config.allowInMemoryRoomStore) {
      throw new Error('REDIS_URL is required unless ALLOW_IN_MEMORY_ROOM_STORE=true');
    }
    logger.warn('REDIS_URL missing, using in-memory room store (fallback mode)');
    return new InMemoryRoomStore();
  }

  const redis = new Redis(config.redisUrl);
  redis.on('error', (error) => {
    logger.error({ error }, 'redis error');
  });
  return new RedisRoomStore(redis);
})();

const persistenceRepo = (() => {
  if (!config.enableDbPersistence) {
    logger.warn('DB persistence disabled (ENABLE_DB_PERSISTENCE=false)');
    return new NoopPersistenceRepository();
  }

  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required when ENABLE_DB_PERSISTENCE=true');
  }

  return new PostgresPersistenceRepository();
})();

const io = new SocketIOServer(app.server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const gameService = new GameService(io, roomStore, persistenceRepo, logger);
attachSocketHandlers(io, gameService, logger);

app.get('/health', async () => ({ ok: true, now: Date.now() }));
app.get('/version', async () => ({ name: 'slaphard-server', version: '0.1.0' }));

const start = async (): Promise<void> => {
  try {
    await app.listen({ host: '0.0.0.0', port: config.port });
    logger.info({ port: config.port }, 'server listening');
  } catch (error) {
    logger.error({ error }, 'server bootstrap failed');
    process.exit(1);
  }
};

const shutdown = async (): Promise<void> => {
  await closeDbPool();
  await app.close();
};

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

void start();
