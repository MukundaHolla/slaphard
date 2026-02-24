import type { ACTION_CARDS, NORMAL_CARDS } from './constants';
import type { ErrorCode } from './errors';

export type NormalCard = (typeof NORMAL_CARDS)[number];
export type ActionCard = (typeof ACTION_CARDS)[number];
export type Card = NormalCard | ActionCard;
export type Gesture = ActionCard;

export type SlapWindowReason = 'MATCH' | 'ACTION';
export type GameStatus = 'LOBBY' | 'IN_GAME' | 'FINISHED';
export type RoomStatus = GameStatus;

export interface GameConfig {
  slapWindowMs: number;
  turnTimeoutMs: number;
  minHumanMs: number;
}

export interface SlapAttempt {
  userId: string;
  eventId: string;
  gesture?: Gesture | undefined;
  clientSeq: number;
  clientTime: number;
  offsetMs: number;
  rttMs: number;
  receivedAtServerTime: number;
}

export interface LastRevealed {
  card: Card;
  chantWord: NormalCard;
  byUserId: string;
  bySeatIndex: number;
  atServerTime: number;
}

export interface SlapWindowState {
  active: boolean;
  eventId?: string | undefined;
  reason?: SlapWindowReason | undefined;
  actionCard?: ActionCard | undefined;
  startServerTime?: number | undefined;
  deadlineServerTime?: number | undefined;
  slapWindowMs?: number | undefined;
  flipperSeat?: number | undefined;
  receivedSlapsCount: number;
  attempts: SlapAttempt[];
  resolved: boolean;
}

export interface EnginePlayerState {
  userId: string;
  displayName: string;
  seatIndex: number;
  connected: boolean;
  ready: boolean;
  hand: Card[];
}

export interface PublicPlayerState {
  userId: string;
  displayName: string;
  seatIndex: number;
  connected: boolean;
  ready: boolean;
  handCount: number;
}

export interface GameState {
  status: Exclude<GameStatus, 'LOBBY'>;
  players: EnginePlayerState[];
  currentTurnSeat: number;
  chantIndex: number;
  pile: Card[];
  pileCount: number;
  pileTopCard?: Card | undefined;
  lastRevealed?: LastRevealed | undefined;
  slapWindow: SlapWindowState;
  winnerUserId?: string | undefined;
  version: number;
  nextSlapEventNonce: number;
  config: GameConfig;
}

export interface GameStateView {
  status: Exclude<GameStatus, 'LOBBY'>;
  players: PublicPlayerState[];
  meHand: Card[];
  currentTurnSeat: number;
  chantIndex: number;
  pileCount: number;
  pileTopCard?: Card | undefined;
  lastRevealed?: LastRevealed | undefined;
  slapWindow: Omit<SlapWindowState, 'attempts' | 'flipperSeat'>;
  winnerUserId?: string | undefined;
  version: number;
}

export interface RoomPlayer {
  userId: string;
  displayName: string;
  seatIndex: number;
  connected: boolean;
  ready: boolean;
}

export interface RoomState {
  roomId: string;
  roomCode: string;
  status: RoomStatus;
  hostUserId: string;
  players: RoomPlayer[];
  gameState?: GameState | undefined;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceError {
  code: ErrorCode;
  message: string;
  details?: unknown | undefined;
}
