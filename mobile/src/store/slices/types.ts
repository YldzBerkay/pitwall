import type { GameState } from '../gameStore';

/** What every slice receives: zustand's set/get, typed on the whole store so slices can read core state. */
export type SliceSet = (partial: Partial<GameState> | ((state: GameState) => Partial<GameState>)) => void;
export type SliceGet = () => GameState;
export type SliceCreator<T> = (set: SliceSet, get: SliceGet) => T;
