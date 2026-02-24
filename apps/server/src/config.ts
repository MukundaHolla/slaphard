const envFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) {
    return defaultValue;
  }
  return value === '1' || value.toLowerCase() === 'true';
};

export const config = {
  port: Number(process.env.PORT ?? 3001),
  redisUrl: process.env.REDIS_URL,
  databaseUrl: process.env.DATABASE_URL,
  enableDbPersistence: envFlag(process.env.ENABLE_DB_PERSISTENCE, true),
  allowInMemoryRoomStore: envFlag(process.env.ALLOW_IN_MEMORY_ROOM_STORE, false),
};
