import Fastify from 'fastify';
import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { logger } from './logger';
import { GameService } from './service/game-service';
import { InMemoryRoomStore } from './store/in-memory-room-store';
import { RedisRoomStore } from './store/redis-room-store';
import { attachSocketHandlers } from './socket';

const app = Fastify({ loggerInstance: logger });

const roomStore = (() => {
  if (!config.redisUrl) {
    logger.warn('REDIS_URL missing, using in-memory room store');
    return new InMemoryRoomStore();
  }

  const redis = new Redis(config.redisUrl);
  redis.on('error', (error) => {
    logger.error({ error }, 'redis error');
  });
  return new RedisRoomStore(redis);
})();

const io = new SocketIOServer(app.server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const gameService = new GameService(io, roomStore, logger);
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

void start();
