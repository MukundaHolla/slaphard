export const config = {
  port: Number(process.env.PORT ?? 3001),
  redisUrl: process.env.REDIS_URL,
};
