import type { ErrorCode, GameState, Gesture, ServiceError, SlapWindowReason } from '@slaphard/shared';

export type EngineEvent =
  | {
      type: 'FLIP';
      userId: string;
    }
  | {
      type: 'SLAP';
      userId: string;
      eventId: string;
      gesture?: Gesture;
      clientSeq: number;
      clientTime: number;
      offsetMs: number;
      rttMs: number;
    }
  | {
      type: 'RESOLVE_SLAP_WINDOW';
    }
  | {
      type: 'TURN_TIMEOUT';
    };

export type EngineEffect =
  | {
      type: 'SLAP_WINDOW_OPEN';
      eventId: string;
      reason: SlapWindowReason;
      actionCard?: Gesture;
      startServerTime: number;
      deadlineServerTime: number;
      slapWindowMs: number;
    }
  | {
      type: 'SLAP_RESULT';
      eventId: string;
      orderedUserIds: string[];
      loserUserId: string;
      reason: string;
    }
  | {
      type: 'PENALTY';
      userId: string;
      penaltyType: 'FALSE_SLAP' | 'WRONG_GESTURE' | 'TURN_TIMEOUT' | 'NO_SLAPS';
      pileTaken: number;
    }
  | {
      type: 'GAME_FINISHED';
      winnerUserId: string;
    };

export type ValidationResult = { ok: true } | { ok: false; code: ErrorCode };

export interface EngineResult {
  state: GameState;
  effects: EngineEffect[];
  error?: ServiceError;
}

export interface InitialPlayer {
  userId: string;
  displayName: string;
  connected?: boolean;
  ready?: boolean;
}

export interface CreateInitialStateConfig {
  players: InitialPlayer[];
  seed?: string | number;
  deck?: import('@slaphard/shared').Card[];
  shuffle?: boolean;
  nowServerTime: number;
  slapWindowMs?: number;
  actionSlapWindowMs?: number;
  turnTimeoutMs?: number;
  minHumanMs?: number;
}
