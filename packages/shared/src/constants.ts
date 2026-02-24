export const NORMAL_CARDS = ['TACO', 'CAT', 'GOAT', 'CHEESE', 'PIZZA'] as const;
export const ACTION_CARDS = ['GORILLA', 'NARWHAL', 'GROUNDHOG'] as const;
export const ALL_CARDS = [...NORMAL_CARDS, ...ACTION_CARDS] as const;
export const CHANT_ORDER = [...NORMAL_CARDS] as const;

export const TURN_TIMEOUT_MS = 5000;
export const SLAP_WINDOW_MS = 2000;
export const MIN_HUMAN_MS = 60;
export const ROOM_TTL_SECONDS = 3600;
export const PING_INTERVAL_IN_GAME_MS = 2000;
export const PING_INTERVAL_LOBBY_MS = 10000;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const ROOM_CODE_LENGTH = 6;
