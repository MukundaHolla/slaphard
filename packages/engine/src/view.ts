import type { GameState, GameStateView } from '@slaphard/shared';

export const buildGameStateView = (state: GameState, meUserId: string): GameStateView => {
  const me = state.players.find((player) => player.userId === meUserId);

  const slapWindow = {
    active: state.slapWindow.active,
    receivedSlapsCount: state.slapWindow.receivedSlapsCount,
    slappedUserIds: state.slapWindow.attempts.map((attempt) => attempt.userId),
    resolved: state.slapWindow.resolved,
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
  };

  return {
    status: state.status,
    players: state.players.map((player) => ({
      userId: player.userId,
      displayName: player.displayName,
      seatIndex: player.seatIndex,
      connected: player.connected,
      ready: player.ready,
      handCount: player.hand.length,
    })),
    meHand: me ? [...me.hand] : [],
    currentTurnSeat: state.currentTurnSeat,
    chantIndex: state.chantIndex,
    pileCount: state.pileCount,
    ...(state.pileTopCard ? { pileTopCard: state.pileTopCard } : {}),
    ...(state.lastRevealed ? { lastRevealed: { ...state.lastRevealed } } : {}),
    slapWindow,
    ...(state.winnerUserId ? { winnerUserId: state.winnerUserId } : {}),
    version: state.version,
  };
};
