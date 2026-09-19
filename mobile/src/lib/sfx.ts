import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

/**
 * Garage sound effects.
 *
 * Players are created lazily and kept for the app's lifetime — the upgrade
 * sounds are short and fire repeatedly, so re-creating a player per tap would
 * add audible latency. Playback never rejects into the caller: a missing or
 * unsupported audio device should not break an upgrade.
 */
export type SfxName = 'wrench' | 'partFitted' | 'spark' | 'denied';

const sources: Record<SfxName, number> = {
  wrench: require('../../assets/sfx/wrench.wav'),
  partFitted: require('../../assets/sfx/part-fitted.wav'),
  spark: require('../../assets/sfx/spark.wav'),
  denied: require('../../assets/sfx/denied.wav'),
};

const volumes: Record<SfxName, number> = {
  wrench: 0.55,
  partFitted: 0.75,
  spark: 0.35,
  denied: 0.6,
};

const players: Partial<Record<SfxName, AudioPlayer>> = {};
let audioModeReady = false;
let muted = false;

async function ensureAudioMode() {
  if (audioModeReady) return;
  audioModeReady = true;
  try {
    // Effects should never interrupt the user's music or grab the audio focus.
    await setAudioModeAsync({
      playsInSilentMode: false,
      shouldRouteThroughEarpiece: false,
      interruptionMode: 'mixWithOthers',
    });
  } catch {
    // Non-fatal: the effects still play with the platform defaults.
  }
}

function playerFor(name: SfxName): AudioPlayer | undefined {
  if (players[name]) return players[name];
  try {
    const player = createAudioPlayer(sources[name]);
    player.volume = volumes[name];
    players[name] = player;
    return player;
  } catch {
    return undefined;
  }
}

export const sfx = {
  /** Play an effect from its start. Safe to call rapidly. */
  play(name: SfxName) {
    if (muted) return;
    void ensureAudioMode();
    const player = playerFor(name);
    if (!player) return;
    try {
      player.seekTo(0);
      player.play();
    } catch {
      // Ignore: a failed effect must not interrupt gameplay.
    }
  },

  /**
   * The full upgrade cue: the rattle gun runs, then the part seats.
   * Returns the delay (ms) at which the part-fitted beat lands, so the
   * animation can sync its flash to the sound.
   */
  playUpgradeSequence(): number {
    const fitAt = 620;
    this.play('wrench');
    setTimeout(() => this.play('spark'), 260);
    setTimeout(() => this.play('partFitted'), fitAt);
    return fitAt;
  },

  setMuted(value: boolean) {
    muted = value;
  },

  isMuted() {
    return muted;
  },

  /** Release native players — call on teardown if the screen unmounts for good. */
  dispose() {
    for (const key of Object.keys(players) as SfxName[]) {
      try {
        players[key]?.remove();
      } catch {
        // Already released.
      }
      delete players[key];
    }
  },
};
