import {
  CHANT_ORDER,
  type ErrorCode,
  type GameState,
  type Gesture,
  type ServiceError,
} from '@slaphard/shared';
import { isActionCard } from './deck';
import {
  advanceSeat,
  cloneState,
  currentChantWord,
  deterministicEventId,
  pileToBottom,
  resetSlapWindow,
  resolveReactionMs,
} from './state';
import type { EngineEffect, EngineEvent, EngineResult, ValidationResult } from './types';

const engineError = (code: ErrorCode, message: string): ServiceError => ({ code, message });

const playerSeatByUserId = (state: GameState, userId: string): number =>
  state.players.findIndex((player) => player.userId === userId);

const validateFlip = (state: GameState, userId: string): ValidationResult => {
  if (state.status !== 'IN_GAME') {
    return { ok: false, code: 'NOT_IN_GAME' };
  }
  if (state.slapWindow.active && !state.slapWindow.resolved) {
    return { ok: false, code: 'SLAP_WINDOW_ACTIVE' };
  }
  if (state.players[state.currentTurnSeat]?.userId !== userId) {
    return { ok: false, code: 'NOT_YOUR_TURN' };
  }
  return { ok: true };
};

const resolveWinnerCondition = (state: GameState, orderedUserIds: string[]): string | undefined => {
  if (orderedUserIds.length === 0) {
    return undefined;
  }
  const firstUserId = orderedUserIds[0]!;
  const seat = playerSeatByUserId(state, firstUserId);
  if (seat === -1) {
    return undefined;
  }
  if ((state.players[seat]?.hand.length ?? 0) === 0) {
    return firstUserId;
  }
  return undefined;
};

const resolveSlapWindowInternal = (state: GameState): { effects: EngineEffect[] } => {
  const effects: EngineEffect[] = [];
  if (!state.slapWindow.active || !state.slapWindow.eventId || state.slapWindow.resolved) {
    return { effects };
  }

  const window = state.slapWindow;
  const windowEventId = window.eventId;
  if (!windowEventId) {
    return { effects };
  }
  const validAttempts = [...window.attempts].sort((a, b) => {
    const r1 = resolveReactionMs(
      a.clientTime,
      a.offsetMs,
      window.startServerTime!,
      state.config.minHumanMs,
      window.slapWindowMs!,
    );
    const r2 = resolveReactionMs(
      b.clientTime,
      b.offsetMs,
      window.startServerTime!,
      state.config.minHumanMs,
      window.slapWindowMs!,
    );

    if (r1 !== r2) {
      return r1 - r2;
    }
    return a.receivedAtServerTime - b.receivedAtServerTime;
  });

  const orderedUserIds = validAttempts.map((attempt) => attempt.userId);

  if (orderedUserIds.length === 0) {
    const loserSeat = window.flipperSeat ?? state.currentTurnSeat;
    const loserUserId = state.players[loserSeat]!.userId;
    const pileTaken = pileToBottom(state, loserSeat);
    state.currentTurnSeat = loserSeat;

    effects.push({
      type: 'PENALTY',
      userId: loserUserId,
      penaltyType: 'NO_SLAPS',
      pileTaken,
    });
    effects.push({
      type: 'SLAP_RESULT',
      eventId: windowEventId,
      orderedUserIds,
      loserUserId,
      reason: 'NO_SLAPS',
    });

    resetSlapWindow(state);
    state.version += 1;
    return { effects };
  }

  const winnerUserId = resolveWinnerCondition(state, orderedUserIds);
  const slapperSet = new Set(orderedUserIds);
  const nonSlappers = state.players
    .map((player) => player.userId)
    .filter((userId) => !slapperSet.has(userId));
  const loserUserId =
    nonSlappers.length > 0 ? nonSlappers[nonSlappers.length - 1]! : orderedUserIds[orderedUserIds.length - 1]!;

  effects.push({
    type: 'SLAP_RESULT',
    eventId: windowEventId,
    orderedUserIds,
    loserUserId,
    reason: nonSlappers.length > 0 ? 'NON_SLAPPER' : 'LAST_SLAPPER',
  });

  if (winnerUserId) {
    state.status = 'FINISHED';
    state.winnerUserId = winnerUserId;
    resetSlapWindow(state);
    state.version += 1;
    effects.push({
      type: 'GAME_FINISHED',
      winnerUserId,
    });
    return { effects };
  }

  const loserSeat = playerSeatByUserId(state, loserUserId);
  if (loserSeat >= 0) {
    pileToBottom(state, loserSeat);
    state.currentTurnSeat = loserSeat;
  }

  resetSlapWindow(state);
  state.version += 1;
  return { effects };
};

const applyPenalty = (
  state: GameState,
  seat: number,
  penaltyType: 'FALSE_SLAP' | 'WRONG_GESTURE' | 'TURN_TIMEOUT',
): EngineEffect => {
  const userId = state.players[seat]!.userId;
  const pileTaken = pileToBottom(state, seat);
  state.currentTurnSeat = seat;
  resetSlapWindow(state);
  return {
    type: 'PENALTY',
    userId,
    penaltyType,
    pileTaken,
  };
};

export const validateEvent = (state: GameState, event: EngineEvent): ValidationResult => {
  if (event.type === 'FLIP') {
    return validateFlip(state, event.userId);
  }

  if (event.type === 'RESOLVE_SLAP_WINDOW') {
    if (state.status !== 'IN_GAME') {
      return { ok: false, code: 'NOT_IN_GAME' };
    }
    if (!state.slapWindow.active || state.slapWindow.resolved) {
      return { ok: false, code: 'NO_SLAP_WINDOW' };
    }
    return { ok: true };
  }

  if (event.type === 'TURN_TIMEOUT') {
    if (state.status !== 'IN_GAME') {
      return { ok: false, code: 'NOT_IN_GAME' };
    }
    if (state.slapWindow.active && !state.slapWindow.resolved) {
      return { ok: false, code: 'SLAP_WINDOW_ACTIVE' };
    }
    return { ok: true };
  }

  if (state.status !== 'IN_GAME') {
    return { ok: false, code: 'NOT_IN_GAME' };
  }
  return { ok: true };
};

export const applyEvent = (state: GameState, event: EngineEvent, nowServerTime: number): EngineResult => {
  const validation = validateEvent(state, event);
  const next = cloneState(state);

  if (!validation.ok && event.type !== 'SLAP') {
    return {
      state,
      effects: [],
      error: engineError(validation.code, `invalid event: ${event.type}`),
    };
  }

  if (event.type === 'FLIP') {
    if (!validation.ok) {
      return {
        state,
        effects: [],
        error: engineError(validation.code, 'flip rejected'),
      };
    }

    const current = next.players[next.currentTurnSeat];
    const flipped = current?.hand.shift();
    if (!current || !flipped) {
      return {
        state,
        effects: [],
        error: engineError('NOT_YOUR_TURN', 'turn player has no card to flip'),
      };
    }

    const chantWord = currentChantWord(next);
    next.pile.push(flipped);
    next.pileCount = next.pile.length;
    next.pileTopCard = flipped;
    next.lastRevealed = {
      card: flipped,
      chantWord,
      byUserId: current.userId,
      bySeatIndex: current.seatIndex,
      atServerTime: nowServerTime,
    };

    const shouldOpenForMatch = CHANT_ORDER.includes(flipped as (typeof CHANT_ORDER)[number]) && flipped === chantWord;
    if (shouldOpenForMatch || isActionCard(flipped)) {
      const eventId = deterministicEventId(next.nextSlapEventNonce);
      next.nextSlapEventNonce += 1;

      const reason = shouldOpenForMatch ? ('MATCH' as const) : ('ACTION' as const);
      const nextSlapWindowBase = {
        active: true,
        eventId,
        reason,
        startServerTime: nowServerTime,
        deadlineServerTime: nowServerTime + next.config.slapWindowMs,
        slapWindowMs: next.config.slapWindowMs,
        flipperSeat: next.currentTurnSeat,
        receivedSlapsCount: 0,
        attempts: [],
        resolved: false,
      };
      if (isActionCard(flipped)) {
        next.slapWindow = { ...nextSlapWindowBase, actionCard: flipped };
      } else {
        next.slapWindow = nextSlapWindowBase;
      }

      next.chantIndex = (next.chantIndex + 1) % CHANT_ORDER.length;
      next.version += 1;

      const slapWindowOpenEffect: EngineEffect = {
        type: 'SLAP_WINDOW_OPEN',
        eventId,
        reason: next.slapWindow.reason!,
        startServerTime: next.slapWindow.startServerTime!,
        deadlineServerTime: next.slapWindow.deadlineServerTime!,
        slapWindowMs: next.slapWindow.slapWindowMs!,
        ...(next.slapWindow.actionCard ? { actionCard: next.slapWindow.actionCard } : {}),
      };

      return {
        state: next,
        effects: [slapWindowOpenEffect],
      };
    }

    next.currentTurnSeat = advanceSeat(next.currentTurnSeat, next.players.length);
    next.chantIndex = (next.chantIndex + 1) % CHANT_ORDER.length;
    next.version += 1;

    return { state: next, effects: [] };
  }

  if (event.type === 'TURN_TIMEOUT') {
    if (!validation.ok) {
      return {
        state,
        effects: [],
        error: engineError(validation.code, 'turn timeout rejected'),
      };
    }

    const penalty = applyPenalty(next, next.currentTurnSeat, 'TURN_TIMEOUT');
    next.version += 1;
    return { state: next, effects: [penalty] };
  }

  if (event.type === 'RESOLVE_SLAP_WINDOW') {
    if (!validation.ok) {
      return {
        state,
        effects: [],
        error: engineError(validation.code, 'slap resolve rejected'),
      };
    }

    const result = resolveSlapWindowInternal(next);
    return { state: next, effects: result.effects };
  }

  const slapSeat = playerSeatByUserId(next, event.userId);
  if (slapSeat < 0) {
    return {
      state,
      effects: [],
      error: engineError('INTERNAL_ERROR', 'unknown slapper'),
    };
  }

  const activeWindow = next.slapWindow;
  const invalidWindow =
    !activeWindow.active || activeWindow.resolved || !activeWindow.eventId || activeWindow.eventId !== event.eventId;

  if (invalidWindow) {
    const penalty = applyPenalty(next, slapSeat, 'FALSE_SLAP');
    next.version += 1;
    return { state: next, effects: [penalty] };
  }

  const duplicate = activeWindow.attempts.some((attempt) => attempt.userId === event.userId);
  if (duplicate) {
    return {
      state,
      effects: [],
      error: engineError('ALREADY_SLAPPED', 'duplicate slap ignored'),
    };
  }

  if (activeWindow.reason === 'ACTION') {
    const expected = activeWindow.actionCard as Gesture;
    if (!event.gesture || event.gesture !== expected) {
      const penalty = applyPenalty(next, slapSeat, 'WRONG_GESTURE');
      next.version += 1;
      return { state: next, effects: [penalty] };
    }
  }

  activeWindow.attempts.push({
    userId: event.userId,
    eventId: event.eventId,
    ...(event.gesture ? { gesture: event.gesture } : {}),
    clientSeq: event.clientSeq,
    clientTime: event.clientTime,
    offsetMs: event.offsetMs,
    rttMs: event.rttMs,
    receivedAtServerTime: nowServerTime,
  });
  activeWindow.receivedSlapsCount = activeWindow.attempts.length;

  if (activeWindow.receivedSlapsCount === 1 && (next.players[slapSeat]?.hand.length ?? 1) === 0) {
    next.status = 'FINISHED';
    next.winnerUserId = event.userId;

    const resultEventId = activeWindow.eventId;
    if (!resultEventId) {
      return {
        state,
        effects: [],
        error: engineError('INTERNAL_ERROR', 'missing slap event id'),
      };
    }
    resetSlapWindow(next);
    next.version += 1;

    return {
      state: next,
      effects: [
        {
          type: 'SLAP_RESULT',
          eventId: resultEventId,
          orderedUserIds: [event.userId],
          loserUserId: event.userId,
          reason: 'FIRST_VALID_SLAP_WIN',
        },
        {
          type: 'GAME_FINISHED',
          winnerUserId: event.userId,
        },
      ],
    };
  }

  if (activeWindow.receivedSlapsCount >= next.players.length) {
    const result = resolveSlapWindowInternal(next);
    return { state: next, effects: result.effects };
  }

  next.version += 1;
  return { state: next, effects: [] };
};
