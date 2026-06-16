/**
 * sessionStore.js — Zustand store wiring the AudioEngine to the UI.
 *
 * Owns the live session: receives swallow events from the worklet, maintains a
 * rolling swallows-per-minute rate over a 60 s window, fires overpace feedback,
 * and persists the session + check-in to IndexedDB on stop.
 *
 * The AudioEngine and timers live in module scope (not in store state) so they
 * stay out of React's serialized/rendered state.
 */
import { create } from 'zustand';
import { AudioEngine, EngineState } from '../audio/AudioEngine.js';
import { overpaceFeedback, primeHaptics } from '../audio/haptics.js';
import { saveSession, saveCheckIn } from '../db/db.js';

const ROLLING_WINDOW_MS = 60_000; // swallows/min computed over the last 60 s
const TICK_MS = 250; // UI refresh cadence

let engine = null;
let ticker = null;

/** Rolling rate in swallows/minute. Normalizes by elapsed time early on so a
 *  single swallow at second 5 doesn't read as a wild extrapolation. */
function computeRate(swallows, startedAt, now) {
  const windowStart = now - ROLLING_WINDOW_MS;
  const inWindow = swallows.filter((t) => t >= windowStart).length;
  const elapsedSec = Math.max(1, (now - startedAt) / 1000);
  const windowSec = Math.min(elapsedSec, ROLLING_WINDOW_MS / 1000);
  return (inWindow / windowSec) * 60;
}

const MAX_DEBUG_EVENTS = 14;

/** Prepend an event to the capped debug log (newest first). */
function pushEvent(list, event) {
  return [event, ...list].slice(0, MAX_DEBUG_EVENTS);
}

export const useSessionStore = create((set, get) => ({
  // --- status ---
  engineState: EngineState.IDLE,
  error: null,
  calibration: null, // { baseline, threshold }

  // --- live metrics ---
  startedAt: null,
  elapsedMs: 0,
  swallowTimes: [], // event timestamps (ms) for the rolling window
  swallowCount: 0,
  rate: 0,
  level: 0, // latest RMS (for an optional meter)

  // --- pacing config ---
  paceThreshold: 12, // swallows/min that counts as "overpace"
  overpaceEvents: 0,

  // --- post-meal flow ---
  showCheckIn: false,
  lastSessionId: null,

  // --- debug / tuning ---
  showDebug: false,
  debugEvents: [], // recent accepted + rejected candidates (newest first)
  peakLevel: 0, // running peak RMS, for scaling the meter

  toggleDebug: () => set((s) => ({ showDebug: !s.showDebug })),

  setPaceThreshold: (n) => set({ paceThreshold: n }),

  isOverpace: () => get().rate > get().paceThreshold,

  /** Pace zone for color coding: green / orange / red. */
  paceZone: () => {
    const { rate, paceThreshold } = get();
    if (rate >= paceThreshold) return 'over';
    if (rate >= paceThreshold * 0.75) return 'warn';
    return 'good';
  },

  /** Start a session. Must be called from a user gesture (START tap). */
  startSession: async () => {
    if (engine) return;

    // Prime the iOS fallback tone generator while we still hold the gesture.
    primeHaptics();

    set({
      error: null,
      startedAt: Date.now(),
      elapsedMs: 0,
      swallowTimes: [],
      swallowCount: 0,
      rate: 0,
      peakLevel: 0,
      overpaceEvents: 0,
      calibration: null,
      showCheckIn: false,
      debugEvents: [],
    });

    engine = new AudioEngine(
      {
        onState: (s) => set({ engineState: s }),
        onError: (err) => set({ error: err, engineState: EngineState.ERROR }),
        onCalibrated: (msg) => set({ calibration: msg }),
        onLevel: (msg) =>
          set((s) => ({
            level: msg.rms,
            peakLevel: Math.max(s.peakLevel * 0.995, msg.rms), // slow decay
          })),
        onSwallow: (msg) => get()._onSwallow(msg),
        onRejected: (msg) => get()._onRejected(msg),
      },
      {
        // processorOptions forwarded into the worklet
        thresholdMultiplier: 3.5,
        calibrationMs: 3000,
      }
    );

    await engine.start();

    ticker = setInterval(() => get()._tick(), TICK_MS);
  },

  _onSwallow: (msg) => {
    const now = Date.now();
    const state = get();
    const times = [...state.swallowTimes, now];
    const rate = computeRate(times, state.startedAt, now);

    // eslint-disable-next-line no-console
    console.log(
      `[intero] 🫗 swallow #${state.swallowCount + 1} — dur ${Math.round(msg.duration)}ms, ` +
        `SNR ${msg.snr.toFixed(1)}, rate ${rate.toFixed(1)}/min`
    );

    let overpaceEvents = state.overpaceEvents;
    if (rate > state.paceThreshold) {
      overpaceEvents += 1;
      overpaceFeedback();
    }

    set({
      swallowTimes: times,
      swallowCount: state.swallowCount + 1,
      rate,
      overpaceEvents,
      debugEvents: pushEvent(state.debugEvents, {
        kind: 'swallow',
        t: now,
        duration: msg.duration,
        snr: msg.snr,
      }),
    });
  },

  _onRejected: (msg) => {
    console.debug('[intero] rejected candidate', msg.reason, Math.round(msg.duration), 'ms');
    set((s) => ({
      debugEvents: pushEvent(s.debugEvents, {
        kind: 'rejected',
        t: Date.now(),
        duration: msg.duration,
        reason: msg.reason,
      }),
    }));
  },

  _tick: () => {
    const state = get();
    if (!state.startedAt) return;
    const now = Date.now();
    // Drop events older than the rolling window so memory stays bounded.
    const times = state.swallowTimes.filter((t) => t >= now - ROLLING_WINDOW_MS);
    set({
      elapsedMs: now - state.startedAt,
      rate: computeRate(times, state.startedAt, now),
      swallowTimes: times,
    });
  },

  recalibrate: () => engine?.recalibrate(),

  /** Stop the session, persist it, and open the check-in. */
  stopSession: async () => {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }

    const state = get();
    const endedAt = Date.now();
    const durationMs = state.startedAt ? endedAt - state.startedAt : 0;

    let lastSessionId = null;
    if (state.startedAt) {
      try {
        lastSessionId = await saveSession({
          startedAt: state.startedAt,
          endedAt,
          durationMs,
          swallowCount: state.swallowCount,
          overpaceEvents: state.overpaceEvents,
          paceThreshold: state.paceThreshold,
          baseline: state.calibration?.baseline ?? null,
        });
      } catch (e) {
        console.error('[intero] failed to save session', e);
      }
    }

    if (engine) {
      await engine.stop();
      engine = null;
    }

    set({
      engineState: EngineState.IDLE,
      elapsedMs: durationMs,
      lastSessionId,
      showCheckIn: state.swallowCount > 0 || durationMs > 0,
    });
  },

  /** Save post-meal check-in answers and close the flow. */
  submitCheckIn: async (answers) => {
    const { lastSessionId } = get();
    if (lastSessionId != null) {
      try {
        await saveCheckIn(lastSessionId, answers);
      } catch (e) {
        console.error('[intero] failed to save check-in', e);
      }
    }
    set({ showCheckIn: false, lastSessionId: null });
  },

  dismissCheckIn: () => set({ showCheckIn: false, lastSessionId: null }),
}));
