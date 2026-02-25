import { ACTION_CARDS, ALL_CARDS, MAX_PLAYERS, MIN_PLAYERS } from '@slaphard/shared';
import type { Card } from '@slaphard/shared';

export const DEFAULT_DECK: Card[] = [
  ...Array(2).fill('TACO'),
  ...Array(2).fill('CAT'),
  ...Array(2).fill('GOAT'),
  ...Array(2).fill('CHEESE'),
  ...Array(2).fill('PIZZA'),
  ...Array(2).fill('GORILLA'),
  ...Array(2).fill('NARWHAL'),
  ...Array(1).fill('GROUNDHOG'),
] as Card[];

export const isValidDeck = (cards: Card[]): boolean => cards.every((card) => ALL_CARDS.includes(card));

const hashSeed = (seed: string | number): number => {
  if (typeof seed === 'number') {
    return seed >>> 0;
  }

  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0) + 0x9e3779b9;
};

const mulberry32 = (seed: number): (() => number) => {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

export const shuffleDeck = (cards: Card[], seed: string | number): Card[] => {
  const rng = mulberry32(hashSeed(seed));
  const deck = [...cards];

  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j] as Card, deck[i] as Card];
  }

  return deck;
};

export const validatePlayerCount = (count: number): boolean => count >= MIN_PLAYERS && count <= MAX_PLAYERS;

export const isActionCard = (card: Card): card is (typeof ACTION_CARDS)[number] =>
  (ACTION_CARDS as readonly string[]).includes(card);
