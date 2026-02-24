import { describe, expect, it } from 'vitest';
import { applyEvent, createInitialState, shuffleDeck } from '../src';

const players = [
  { userId: 'u1', displayName: 'P1' },
  { userId: 'u2', displayName: 'P2' },
];

describe('engine', () => {
  it('deals an even split deterministically with a seed', () => {
    const baseDeck = ['TACO', 'CAT', 'GOAT', 'CHEESE', 'PIZZA', 'GORILLA'] as const;
    const shuffledOne = shuffleDeck([...baseDeck], 'seed-1');
    const shuffledTwo = shuffleDeck([...baseDeck], 'seed-1');
    expect(shuffledOne).toEqual(shuffledTwo);

    const state = createInitialState({
      players,
      deck: [...baseDeck],
      seed: 'seed-1',
      nowServerTime: 1000,
    });

    expect(state.players[0]?.hand.length).toBe(3);
    expect(state.players[1]?.hand.length).toBe(3);
  });

  it('increments chant index on every flip', () => {
    let state = createInitialState({
      players,
      deck: ['CAT', 'GOAT', 'CHEESE', 'PIZZA'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    const first = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010);
    state = first.state;
    expect(state.chantIndex).toBe(1);

    const second = applyEvent(state, { type: 'FLIP', userId: 'u2' }, 1020);
    state = second.state;
    expect(state.chantIndex).toBe(2);
  });

  it('opens slap window on a match card', () => {
    const state = createInitialState({
      players,
      deck: ['TACO', 'CAT', 'GOAT', 'CHEESE'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    const result = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010);
    expect(result.state.slapWindow.active).toBe(true);
    expect(result.state.slapWindow.reason).toBe('MATCH');
    expect(result.effects[0]?.type).toBe('SLAP_WINDOW_OPEN');
  });

  it('opens slap window on an action card', () => {
    const state = createInitialState({
      players,
      deck: ['GORILLA', 'CAT', 'GOAT', 'CHEESE'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    const result = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010);
    expect(result.state.slapWindow.active).toBe(true);
    expect(result.state.slapWindow.reason).toBe('ACTION');
    expect(result.state.slapWindow.actionCard).toBe('GORILLA');
    expect(result.state.slapWindow.slapWindowMs).toBe(3200);
  });

  it('applies immediate wrong-gesture penalty', () => {
    let state = createInitialState({
      players,
      deck: ['GORILLA', 'CAT', 'GOAT', 'CHEESE'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    state = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010).state;
    const eventId = state.slapWindow.eventId!;

    const slap = applyEvent(
      state,
      {
        type: 'SLAP',
        userId: 'u2',
        eventId,
        gesture: 'NARWHAL',
        clientSeq: 1,
        clientTime: 1015,
        offsetMs: 0,
        rttMs: 20,
      },
      1020,
    );

    expect(slap.effects[0]).toMatchObject({ type: 'PENALTY', penaltyType: 'WRONG_GESTURE', userId: 'u2' });
    expect(slap.state.currentTurnSeat).toBe(1);
    expect(slap.state.slapWindow.active).toBe(false);
  });

  it('applies false slap penalty when no slap window is active', () => {
    const state = createInitialState({
      players,
      deck: ['CAT', 'GOAT', 'CHEESE', 'PIZZA'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    const result = applyEvent(
      state,
      {
        type: 'SLAP',
        userId: 'u2',
        eventId: '00000000-0000-4000-8000-000000000001',
        gesture: 'GORILLA',
        clientSeq: 1,
        clientTime: 1005,
        offsetMs: 0,
        rttMs: 20,
      },
      1006,
    );

    expect(result.effects[0]).toMatchObject({ type: 'PENALTY', penaltyType: 'FALSE_SLAP', userId: 'u2' });
    expect(result.state.currentTurnSeat).toBe(1);
  });

  it('uses receivedAt as tie-breaker for slap ordering', () => {
    let state = createInitialState({
      players,
      deck: ['TACO', 'CAT', 'GOAT', 'CHEESE'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    state = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010).state;
    const eventId = state.slapWindow.eventId!;

    state = applyEvent(
      state,
      {
        type: 'SLAP',
        userId: 'u2',
        eventId,
        gesture: 'GORILLA',
        clientSeq: 1,
        clientTime: 1060,
        offsetMs: 0,
        rttMs: 10,
      },
      1020,
    ).state;

    const finalSlap = applyEvent(
      state,
      {
        type: 'SLAP',
        userId: 'u1',
        eventId,
        gesture: 'GORILLA',
        clientSeq: 1,
        clientTime: 1060,
        offsetMs: 0,
        rttMs: 10,
      },
      1030,
    );
    const slapResult = finalSlap.effects.find((effect) => effect.type === 'SLAP_RESULT');
    expect(slapResult).toMatchObject({ orderedUserIds: ['u2', 'u1'], loserUserId: 'u1' });
  });

  it('falls back to flipper when nobody slaps', () => {
    let state = createInitialState({
      players,
      deck: ['TACO', 'CAT', 'GOAT', 'CHEESE'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    state = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010).state;
    const resolved = applyEvent(state, { type: 'RESOLVE_SLAP_WINDOW' }, 3100);

    const penalty = resolved.effects.find((effect) => effect.type === 'PENALTY');
    expect(penalty).toMatchObject({ penaltyType: 'NO_SLAPS', userId: 'u1' });
    expect(resolved.state.currentTurnSeat).toBe(0);
  });

  it('makes loser take pile and become next turn seat', () => {
    let state = createInitialState({
      players,
      deck: ['TACO', 'CAT', 'GOAT', 'CHEESE'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    state = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010).state;
    const eventId = state.slapWindow.eventId!;

    state = applyEvent(
      state,
      {
        type: 'SLAP',
        userId: 'u1',
        eventId,
        gesture: 'GORILLA',
        clientSeq: 1,
        clientTime: 1040,
        offsetMs: 0,
        rttMs: 10,
      },
      1020,
    ).state;

    const resolved = applyEvent(
      state,
      {
        type: 'SLAP',
        userId: 'u2',
        eventId,
        gesture: 'GORILLA',
        clientSeq: 1,
        clientTime: 1100,
        offsetMs: 0,
        rttMs: 10,
      },
      1030,
    );
    expect(resolved.state.currentTurnSeat).toBe(1);
    expect(resolved.state.players[1]?.hand.length).toBeGreaterThan(2);
  });

  it('assigns pile to a non-slapper when only one player slapped', () => {
    let state = createInitialState({
      players,
      deck: ['TACO', 'CAT', 'GOAT', 'CHEESE'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    state = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010).state;
    const eventId = state.slapWindow.eventId!;

    const slapped = applyEvent(
      state,
      {
        type: 'SLAP',
        userId: 'u1',
        eventId,
        gesture: 'GORILLA',
        clientSeq: 1,
        clientTime: 1040,
        offsetMs: 0,
        rttMs: 10,
      },
      1020,
    );
    const resolved = applyEvent(slapped.state, { type: 'RESOLVE_SLAP_WINDOW' }, 4000);
    const slapResult = resolved.effects.find((effect) => effect.type === 'SLAP_RESULT');

    expect(slapResult).toMatchObject({ loserUserId: 'u2', reason: 'NON_SLAPPER' });
    expect(resolved.state.currentTurnSeat).toBe(1);
  });

  it('applies turn-timeout penalty to current turn player', () => {
    let state = createInitialState({
      players,
      deck: ['CAT', 'GOAT', 'CHEESE', 'PIZZA'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    state = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010).state;
    const timeout = applyEvent(state, { type: 'TURN_TIMEOUT' }, 8000);

    expect(timeout.effects[0]).toMatchObject({ type: 'PENALTY', penaltyType: 'TURN_TIMEOUT', userId: 'u2' });
    expect(timeout.state.currentTurnSeat).toBe(1);
  });

  it('enforces win condition when a zero-card player slaps first', () => {
    let state = createInitialState({
      players,
      deck: ['TACO', 'CAT'],
      seed: 1,
      shuffle: false,
      nowServerTime: 1000,
    });

    state.players[1]!.hand = [];

    state = applyEvent(state, { type: 'FLIP', userId: 'u1' }, 1010).state;
    const eventId = state.slapWindow.eventId!;

    const slap = applyEvent(
      state,
      {
        type: 'SLAP',
        userId: 'u2',
        eventId,
        gesture: 'GORILLA',
        clientSeq: 1,
        clientTime: 1050,
        offsetMs: 0,
        rttMs: 5,
      },
      1020,
    );

    expect(slap.state.status).toBe('FINISHED');
    expect(slap.state.winnerUserId).toBe('u2');
  });
});
