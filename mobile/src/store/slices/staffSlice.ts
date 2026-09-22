import {
  hiringFee,
  staffEffects,
  staffMarket,
  startingRoster,
  type StaffEffects,
  type StaffMember,
  type StaffRole,
  type StaffRoster,
} from '@pitwall/shared/staff';
import type { SliceCreator } from './types';

export type HireResult = 'ok' | 'seatTaken' | 'noRp' | 'missing';

/**
 * Heads of department. Three seats; hiring into a full seat needs an explicit
 * release first (the UI asks whom to let go). The market is seeded on the
 * round, so it turns over every game day and cannot be re-rolled.
 */
export interface StaffSlice {
  staff: StaffRoster;
  staffMarket: () => StaffMember[];
  effects: () => StaffEffects;
  hireStaff: (id: string, replace?: boolean) => HireResult;
  releaseStaff: (role: StaffRole) => void;
  /** RP owed to the three seats each race. */
  staffWages: () => number;
}

export const createStaffSlice: SliceCreator<StaffSlice> = (set, get) => ({
  staff: startingRoster,

  staffMarket: () => staffMarket(get().round, get().season),
  effects: () => staffEffects(get().staff),

  hireStaff: (id, replace = false) => {
    const state = get();
    const candidate = state.staffMarket().find((c) => c.id === id);
    if (!candidate) return 'missing';
    if (state.staff[candidate.role] && !replace) return 'seatTaken';
    const fee = hiringFee(candidate);
    if (state.rp < fee) return 'noRp';
    set({ rp: state.rp - fee, staff: { ...state.staff, [candidate.role]: candidate } });
    return 'ok';
  },

  releaseStaff: (role) =>
    set((state) => {
      const next = { ...state.staff };
      delete next[role];
      return { staff: next };
    }),

  staffWages: () => Object.values(get().staff).reduce((sum, m) => sum + (m?.wage ?? 0), 0),
});
