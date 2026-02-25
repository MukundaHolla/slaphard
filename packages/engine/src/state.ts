import {
  ACTION_SLAP_WINDOW_MS,
  CHANT_ORDER,
  MIN_HUMAN_MS,
  SLAP_WINDOW_MS,
  TURN_TIMEOUT_MS,
  type Card,
  type GameState,
} from '@slaphard/shared';
import { DEFAULT_DECK, isValidDeck, shuffleDeck, validatePlayerCount } from './deck';
import type { CreateInitialStateConfig } from './types';

export const createInitialState = (config: CreateInitialStateConfig): GameState => {
  if (!validatePlayerCount(config.players.length)) {
    throw new Error('player count out of range');
  }

  const deckSource = config.deck ?? DEFAULT_DECK;
  if (!isValidDeck(deckSource)) {
    throw new Error('deck contains invalid cards');
  }

  const seed = config.seed ?? String(config.nowServerTime);
  const shuffled = config.shuffle === false ? [...deckSource] : shuffleDeck(deckSource, seed);

  const players = config.players.map((player, index) => ({
    userId: player.userId,
    displayName: player.displayName,
    seatIndex: index,
    connected: player.connected ?? true,
    ready: player.ready ?? false,
    hand: [] as Card[],
  }));

  for (let i = 0; i < shuffled.length; i += 1) {
    players[i % players.length]?.hand.push(shuffled[i] as Card);
  }

  return {
    status: 'IN_GAME',
    players,
    currentTurnSeat: 0,
    chantIndex: 0,
    pile: [],
    pileCount: 0,
    slapWindow: {
      active: false,
      receivedSlapsCount: 0,
      attempts: [],
      resolved: false,
    },
    version: 1,
    nextSlapEventNonce: 1,
    config: {
      slapWindowMs: config.slapWindowMs ?? SLAP_WINDOW_MS,
      actionSlapWindowMs: config.actionSlapWindowMs ?? ACTION_SLAP_WINDOW_MS,
      turnTimeoutMs: config.turnTimeoutMs ?? TURN_TIMEOUT_MS,
      minHumanMs: config.minHumanMs ?? MIN_HUMAN_MS,
    },
  };
};

export const cloneState = (state: GameState): GameState => ({
  ...(state.lastRevealed ? { ...state, lastRevealed: { ...state.lastRevealed } } : state),
  players: state.players.map((player) => ({ ...player, hand: [...player.hand] })),
  pile: [...state.pile],
  slapWindow: (() => {
    const cloned = {
      active: state.slapWindow.active,
      receivedSlapsCount: state.slapWindow.receivedSlapsCount,
      attempts: state.slapWindow.attempts.map((attempt) => ({ ...attempt })),
      resolved: state.slapWindow.resolved,
    };
    return {
      ...cloned,
      ...(state.slapWindow.eventId ? { eventId: state.slapWindow.eventId } : {}),
      ...(state.slapWindow.reason ? { reason: state.slapWindow.reason } : {}),
      ...(state.slapWindow.actionCard ? { actionCard: state.slapWindow.actionCard } : {}),
      ...(state.slapWindow.startServerTime !== undefined
        ? { startServerTime: state.slapWindow.startServerTime }
        : {}),
      ...(state.slapWindow.deadlineServerTime !== undefined
        ? { deadlineServerTime: state.slapWindow.deadlineServerTime }
        : {}),
      ...(state.slapWindow.slapWindowMs !== undefined ? { slapWindowMs: state.slapWindow.slapWindowMs } : {}),
      ...(state.slapWindow.flipperSeat !== undefined ? { flipperSeat: state.slapWindow.flipperSeat } : {}),
    };
  })(),
  config: { ...state.config },
});

export const resetSlapWindow = (state: GameState): void => {
  state.slapWindow = {
    active: false,
    receivedSlapsCount: 0,
    attempts: [],
    resolved: true,
  };
};

export const deterministicEventId = (nonce: number): string => {
  const tail = nonce.toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${tail}`;
};

export const advanceSeat = (seat: number, totalPlayers: number): number => (seat + 1) % totalPlayers;

export const normalizeTurnSeat = (state: GameState): void => {
  if (state.status !== 'IN_GAME') {
    return;
  }
  if (state.players[state.currentTurnSeat]?.hand.length) {
    return;
  }
  if (state.slapWindow.active && !state.slapWindow.resolved) {
    return;
  }

  for (let i = 1; i < state.players.length; i += 1) {
    const seat = (state.currentTurnSeat + i) % state.players.length;
    if ((state.players[seat]?.hand.length ?? 0) > 0) {
      state.currentTurnSeat = seat;
      return;
    }
  }
};

export const pileToBottom = (state: GameState, seat: number): number => {
  const pileTaken = state.pile.length;
  if (pileTaken > 0) {
    state.players[seat]?.hand.push(...state.pile);
  }
  state.pile = [];
  state.pileCount = 0;
  delete state.pileTopCard;
  return pileTaken;
};

export const resolveReactionMs = (
  clientTime: number,
  offsetMs: number,
  t0: number,
  minHumanMs: number,
  slapWindowMs: number,
): number => {
  const estimatedTapServerTime = clientTime + offsetMs;
  let reactionMs = estimatedTapServerTime - t0;

  if (reactionMs < 0) {
    reactionMs = 0;
  }
  if (reactionMs < minHumanMs) {
    reactionMs = minHumanMs;
  }

  const maxReaction = slapWindowMs + 2000;
  if (reactionMs > maxReaction) {
    reactionMs = maxReaction;
  }

  return reactionMs;
};

export const currentChantWord = (state: GameState) => CHANT_ORDER[state.chantIndex]!;
