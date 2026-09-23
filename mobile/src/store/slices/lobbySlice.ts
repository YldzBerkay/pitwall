import {
  createLobby,
  getInvites,
  getSlots,
  inviteToLobby,
  joinLobby,
  quickMatch,
  unlockSlot,
  type CandidateCard,
  type InviteView,
  type LobbySettingsInput,
  type SeatOffer,
  type SlotView,
} from '@/lib/api/lobby';
import type { SliceCreator } from './types';

export const SLOT_COUNT = 5;

/**
 * The account's five slots and the flow that fills them (spec §3, §4).
 *
 * Everything here is a VIEW of server state — the server owns slots, seats
 * and matchmaking (§1.1), and this slice only caches the last answer so the
 * dropdown can draw without a round trip. Nothing in it is authoritative and
 * nothing is persisted: on a cold start `refreshSlots` asks again.
 *
 * Note what is NOT here: the per-lobby economy (RP, factory, roster). That is
 * Faz 3; a lobby opened today still runs its economy from the existing
 * client-side slices, and only identity, seats and matchmaking are real on
 * the server.
 */
export interface LobbySlice {
  lobby: {
    slots: SlotView[];
    /** Which slot the app is currently playing, or undefined on the general screen. */
    activeSlotIndex?: number;
    invites: InviteView[];
    slotPrice: number;
    /** The candidate card on screen, and what has already been shown this sitting. */
    candidate?: CandidateCard;
    shown: string[];
    /**
     * The lobby whose team-selection screen is open, and why we are there:
     * a lobby just created (§3.2 — invisible until its creator sits down) or
     * an invite being accepted (§3.6). A quick-match candidate carries its
     * own card and does not use this.
     */
    teamChoice?: { lobbyId: string; lobbyName: string; note: string; seats: SeatOffer[] };
    status: 'idle' | 'loading';
    error?: string;
  };
  refreshSlots: () => Promise<void>;
  refreshInvites: () => Promise<void>;
  buySlot: (slotIndex: number) => Promise<boolean>;
  /** Opens a lobby. No slot is spent yet — that happens at `takeTeam`. */
  openLobby: (settings: LobbySettingsInput) => Promise<boolean>;
  /** Asks for a candidate; `again` keeps the ones already shown out of it. */
  findGame: (again?: boolean) => Promise<void>;
  /** Opens the team-selection screen for a lobby the player already has access to. */
  chooseTeamIn: (choice: { lobbyId: string; lobbyName: string; note: string; seats: SeatOffer[] }) => void;
  /** Clears the candidate and the "already shown" memory. */
  endSearch: () => void;
  /** THE committing action: take a team, spend a slot (§3.3). */
  takeTeam: (lobbyId: string, teamKey: string) => Promise<boolean>;
  invite: (lobbyId: string, nickname: string) => Promise<boolean>;
  /** Makes a filled slot the one the app is playing. */
  setActiveSlot: (slotIndex: number) => void;
}

const ERROR_LABEL: Record<string, string> = {
  unauthorized: 'Oturumun düşmüş — tekrar giriş yap.',
  no_free_slot: 'Boş slotun yok. Bir slot aç ya da bir sezonu bitir.',
  insufficient_gold: 'Yeterli Altın yok.',
  already_unlocked: 'Bu slot zaten açık.',
  not_purchasable: 'Bu slot satın alınamaz.',
  seat_taken: 'O takımı senden önce kaptılar — başka bir takım seç.',
  already_in_lobby: 'Bu lobide zaten bir takımın var.',
  rank_locked: 'Rütben bu lobinin kapısından geçmiyor.',
  closed: 'Bu lobi yeni katılıma kapalı.',
  invite_required: 'Bu özel lobiye ancak davetle girilir.',
  lobby_not_found: 'Lobi bulunamadı.',
  lobby_full: 'Lobide boş koltuk kalmadı.',
  player_not_found: 'Böyle bir oyuncu yok. Etiketin tamamını yaz: Takma#1234',
  not_in_lobby: 'Bu lobide değilsin.',
  not_allowed: 'Bu lobide daveti yalnızca kurucu gönderebilir.',
  region_required: 'Önce profilinden bölgeni seç.',
  timeout: 'Sunucu yanıt vermedi.',
  network_error: 'Sunucuya ulaşılamadı.',
};

const errorText = (code: string): string => ERROR_LABEL[code] ?? `Hata: ${code}`;

export const createLobbySlice: SliceCreator<LobbySlice> = (set, get) => {
  /** The session every call here needs; undefined while signed out. */
  const session = (): { baseUrl: string; token: string } | undefined => {
    const { baseUrl, token } = get().auth;
    return token ? { baseUrl, token } : undefined;
  };

  const fail = (code: string) => set((s) => ({ lobby: { ...s.lobby, status: 'idle', error: errorText(code) } }));

  return {
    lobby: { slots: [], invites: [], slotPrice: 250, shown: [], status: 'idle' },

    refreshSlots: async () => {
      const auth = session();
      if (!auth) return;
      const res = await getSlots(auth.baseUrl, auth.token);
      if (!res.ok) return fail(res.error);
      set((s) => ({
        lobby: { ...s.lobby, slots: res.data.slots, slotPrice: res.data.slotPrice, error: undefined },
        gold: res.data.gold,
      }));
    },

    refreshInvites: async () => {
      const auth = session();
      if (!auth) return;
      const res = await getInvites(auth.baseUrl, auth.token);
      if (!res.ok) return fail(res.error);
      set((s) => ({ lobby: { ...s.lobby, invites: res.data.invites } }));
    },

    buySlot: async (slotIndex) => {
      const auth = session();
      if (!auth) return false;
      set((s) => ({ lobby: { ...s.lobby, status: 'loading', error: undefined } }));
      const res = await unlockSlot(auth.baseUrl, auth.token, slotIndex);
      if (!res.ok) {
        fail(res.error);
        return false;
      }
      set((s) => ({
        lobby: { ...s.lobby, slots: res.data.slots, status: 'idle', error: undefined },
        gold: res.data.gold,
      }));
      return true;
    },

    openLobby: async (settings) => {
      const auth = session();
      if (!auth) return false;
      set((s) => ({ lobby: { ...s.lobby, status: 'loading', error: undefined } }));
      const res = await createLobby(auth.baseUrl, auth.token, settings);
      if (!res.ok) {
        fail(res.error);
        return false;
      }
      // The lobby exists but is invisible to everyone until its creator takes
      // a team (§3.2), so the flow goes straight on to team selection.
      set((s) => ({
        lobby: {
          ...s.lobby,
          status: 'idle',
          error: undefined,
          candidate: undefined,
          teamChoice: {
            lobbyId: res.data.lobby.id,
            lobbyName: res.data.lobby.name,
            note: 'Kurucu olarak 11 takımın hepsinden seçebilirsin.',
            seats: res.data.seats,
          },
        },
      }));
      return true;
    },

    findGame: async (again = false) => {
      const auth = session();
      if (!auth) return;
      const current = get().lobby;
      // "Başka bul" is free and unlimited (§3.3); all it does is remember
      // what has already been offered in this sitting.
      const shown = again && current.candidate ? [...current.shown, current.candidate.lobby.id] : current.shown;
      set((s) => ({ lobby: { ...s.lobby, status: 'loading', error: undefined, shown } }));

      const res = await quickMatch(auth.baseUrl, auth.token, shown);
      if (!res.ok) return fail(res.error);
      set((s) => ({
        lobby: { ...s.lobby, status: 'idle', candidate: res.data.candidate ?? undefined, error: undefined },
      }));
    },

    chooseTeamIn: (choice) =>
      set((s) => ({ lobby: { ...s.lobby, candidate: undefined, teamChoice: choice, error: undefined } })),

    endSearch: () =>
      set((s) => ({ lobby: { ...s.lobby, candidate: undefined, teamChoice: undefined, shown: [] } })),

    takeTeam: async (lobbyId, teamKey) => {
      const auth = session();
      if (!auth) return false;
      set((s) => ({ lobby: { ...s.lobby, status: 'loading', error: undefined } }));
      const res = await joinLobby(auth.baseUrl, auth.token, { lobbyId, teamKey });
      if (!res.ok) {
        fail(res.error);
        return false;
      }
      set((s) => ({
        lobby: { ...s.lobby, status: 'idle', error: undefined, candidate: undefined, teamChoice: undefined, shown: [] },
      }));
      await get().refreshSlots();
      get().setActiveSlot(res.data.slotIndex);
      return true;
    },

    invite: async (lobbyId, nickname) => {
      const auth = session();
      if (!auth) return false;
      set((s) => ({ lobby: { ...s.lobby, status: 'loading', error: undefined } }));
      const res = await inviteToLobby(auth.baseUrl, auth.token, { lobbyId, nickname });
      if (!res.ok) {
        fail(res.error);
        return false;
      }
      set((s) => ({ lobby: { ...s.lobby, status: 'idle', error: undefined } }));
      return true;
    },

    setActiveSlot: (slotIndex) => {
      const slot = get().lobby.slots.find((s) => s.slotIndex === slotIndex);
      if (!slot?.lobby) return;
      set((s) => ({ lobby: { ...s.lobby, activeSlotIndex: slotIndex } }));
      // Subscribe to this lobby's own live race room (`raceSlice.ts`'s
      // `connectRace`) — the per-lobby replacement for the old single
      // global league.
      get().connectRace(slot.lobbyId ?? slot.lobby.id);
    },
  };
};
