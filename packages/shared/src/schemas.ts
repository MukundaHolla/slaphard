import { z } from 'zod';
import { ACTION_CARDS, ALL_CARDS, CHANT_ORDER, MAX_PLAYERS, MIN_PLAYERS } from './constants';
import { ERROR_CODES } from './errors';

export const cardSchema = z.enum(ALL_CARDS);

export const gestureSchema = z.enum(ACTION_CARDS);
export const roomStatusSchema = z.enum(['LOBBY', 'IN_GAME', 'FINISHED']);
export const slapReasonSchema = z.enum(['MATCH', 'ACTION']);

export const displayNameSchema = z.string().trim().min(2).max(24);
export const roomCodeSchema = z
  .string()
  .trim()
  .length(6)
  .regex(/^[A-Z0-9]+$/);

export const playerSchema = z.object({
  userId: z.string().uuid(),
  displayName: displayNameSchema,
  seatIndex: z.number().int().min(0).max(MAX_PLAYERS - 1),
  connected: z.boolean(),
  ready: z.boolean(),
  handCount: z.number().int().min(0),
});

export const roomPlayerSchema = playerSchema.omit({ handCount: true });

export const slapWindowSchema = z.object({
  active: z.boolean(),
  eventId: z.string().uuid().optional(),
  reason: slapReasonSchema.optional(),
  actionCard: z.enum(ACTION_CARDS).optional(),
  startServerTime: z.number().int().nonnegative().optional(),
  deadlineServerTime: z.number().int().nonnegative().optional(),
  slapWindowMs: z.number().int().positive().optional(),
  receivedSlapsCount: z.number().int().nonnegative(),
  resolved: z.boolean(),
});

export const lastRevealedSchema = z.object({
  card: cardSchema,
  chantWord: z.enum(CHANT_ORDER),
  byUserId: z.string().uuid(),
  bySeatIndex: z.number().int(),
  atServerTime: z.number().int().nonnegative(),
});

export const gameStateViewSchema = z.object({
  status: z.enum(['IN_GAME', 'FINISHED']),
  players: z.array(playerSchema).min(MIN_PLAYERS).max(MAX_PLAYERS),
  meHand: z.array(cardSchema),
  currentTurnSeat: z.number().int(),
  chantIndex: z.number().int().min(0).max(CHANT_ORDER.length - 1),
  pileCount: z.number().int().nonnegative(),
  pileTopCard: cardSchema.optional(),
  lastRevealed: lastRevealedSchema.optional(),
  slapWindow: slapWindowSchema,
  winnerUserId: z.string().uuid().optional(),
  version: z.number().int().nonnegative(),
});

export const roomSchema = z.object({
  roomId: z.string().uuid(),
  roomCode: roomCodeSchema,
  status: roomStatusSchema,
  hostUserId: z.string().uuid(),
  players: z.array(roomPlayerSchema).min(1).max(MAX_PLAYERS),
  version: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const clientEventsSchemas = {
  'v1:room.create': z.object({ displayName: displayNameSchema }),
  'v1:room.join': z.object({
    roomCode: roomCodeSchema,
    displayName: displayNameSchema,
    userId: z.string().uuid().optional(),
  }),
  'v1:room.leave': z.object({}),
  'v1:lobby.ready': z.object({ ready: z.boolean() }),
  'v1:lobby.start': z.object({}),
  'v1:game.stop': z.object({}),
  'v1:game.flip': z.object({
    clientSeq: z.number().int().nonnegative(),
    clientTime: z.number().int().nonnegative(),
  }),
  'v1:game.slap': z.object({
    eventId: z.string().uuid(),
    gesture: z.string().optional(),
    clientSeq: z.number().int().nonnegative(),
    clientTime: z.number().int().nonnegative(),
    offsetMs: z.number().finite(),
    rttMs: z.number().finite(),
  }),
  'v1:ping': z.object({ clientTime: z.number().int().nonnegative() }),
} as const;

export const serverEventsSchemas = {
  'v1:room.state': z.object({
    room: roomSchema,
    meUserId: z.string().uuid(),
  }),
  'v1:game.state': z.object({
    snapshot: gameStateViewSchema,
    serverTime: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
  }),
  'v1:game.delta': z.object({
    patch: z.array(z.unknown()),
    serverTime: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
  }),
  'v1:game.slapWindowOpen': z.object({
    eventId: z.string().uuid(),
    reason: slapReasonSchema,
    actionCard: gestureSchema.optional(),
    startServerTime: z.number().int().nonnegative(),
    deadlineServerTime: z.number().int().nonnegative(),
    slapWindowMs: z.number().int().positive(),
  }),
  'v1:game.slapResult': z.object({
    eventId: z.string().uuid(),
    orderedUserIds: z.array(z.string().uuid()),
    loserUserId: z.string().uuid(),
    reason: z.string(),
  }),
  'v1:penalty': z.object({
    userId: z.string().uuid(),
    type: z.enum(['FALSE_SLAP', 'WRONG_GESTURE', 'TURN_TIMEOUT', 'NO_SLAPS']),
    pileTaken: z.number().int().nonnegative(),
  }),
  'v1:error': z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  'v1:pong': z.object({
    serverTime: z.number().int().nonnegative(),
    clientTimeEcho: z.number().int().nonnegative(),
  }),
} as const;

export type ClientEventName = keyof typeof clientEventsSchemas;
export type ServerEventName = keyof typeof serverEventsSchemas;

export type ClientEventPayload<T extends ClientEventName> = z.infer<
  (typeof clientEventsSchemas)[T]
>;

export type ServerEventPayload<T extends ServerEventName> = z.infer<
  (typeof serverEventsSchemas)[T]
>;
