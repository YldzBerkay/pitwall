import { create } from 'zustand';
import { carStats, teamState, type CarStat } from '@/data/mock';

interface GameState {
  teamName: string;
  round: number;
  totalRounds: number;
  rp: number;
  weekEarned: number;
  carStats: CarStat[];
  /** Spend RP on a car stat upgrade. Returns false if insufficient RP. */
  upgradeStat: (label: string) => boolean;
  /** Collapsible side-nav state (icon-rail when collapsed). */
  navCollapsed: boolean;
  toggleNav: () => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  teamName: teamState.teamName,
  round: teamState.round,
  totalRounds: teamState.totalRounds,
  rp: teamState.rp,
  weekEarned: teamState.weekEarned,
  carStats,
  upgradeStat: (label) => {
    const stat = get().carStats.find((s) => s.label === label);
    if (!stat || get().rp < stat.cost) {
      return false;
    }
    set((state) => ({
      rp: state.rp - stat.cost,
      carStats: state.carStats.map((s) =>
        s.label === label ? { ...s, value: Math.min(100, s.value + 2) } : s,
      ),
    }));
    return true;
  },
  navCollapsed: false,
  toggleNav: () => set((state) => ({ navCollapsed: !state.navCollapsed })),
}));
