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

/** Detection parameters forwarded to the worklet; tunable live from the UI.
 *  These mirror the defaults inside swallow-processor.js. */
const DEFAULT_DETECTION_PARAMS = {
  thresholdMultiplier: 3.5,
  minDuration: 200,
  maxDuration: 900,
  minInterval: 2000,
  releaseRatio: 0.6,
  emaAlpha: 0.6,
  adaptRate: 0.02,
  minSnr: 2.0,
};

// --- Personalized pace model ---------------------------------------------
// There is no evidence-based universal "swallows/min" target, so instead of a
// fixed number we learn the user's own calm cadence and flag *acceleration
// relative to themselves*, capped by an absolute safety ceiling.
const MIN_SWALLOWS_FOR_BASELINE = 5; // learn personal cadence after this many
const BASELINE_LEARN_RATE = 0.04; // slow EMA so the baseline = "calm" pace
const DEFAULT_ACCEL_TOLERANCE = 0.35; // flag at >35% above personal baseline
const DEFAULT_PACE_CEILING = 14; // absolute soft cap (swallows/min)
const MIN_MEANINGFUL_RATE = 4; // below this, never flag (just getting started)

/** The rate at/above which we currently consider the user "overpacing":
 *  the lower of their personal accelerated cadence and the absolute ceiling. */
function effectiveTargetRate(baselineRate, accelTolerance, paceCeiling) {
  if (baselineRate == null) return paceCeiling;
  return Math.min(paceCeiling, baselineRate * (1 + accelTolerance));
}

/** Slowly learn the user's calm cadence. Seeds after enough swallows, then
 *  tracks with a slow EMA — but freezes while overpacing so a fast stretch
 *  can't drag the personal baseline (and thus the target) upward. */
function learnBaseline(baselineRate, rate, swallowCount, target) {
  if (swallowCount < MIN_SWALLOWS_FOR_BASELINE) return baselineRate;
  if (baselineRate == null) return rate; // seed
  if (rate > target) return baselineRate; // don't learn from overpace
  return baselineRate * (1 - BASELINE_LEARN_RATE) + rate * BASELINE_LEARN_RATE;
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

  // --- pacing config (personalized; see effectiveTargetRate) ---
  baselineRate: null, // learned "calm" swallows/min for this user/session
  accelTolerance: DEFAULT_ACCEL_TOLERANCE,
  paceCeiling: DEFAULT_PACE_CEILING, // absolute soft cap
  overpaceEvents: 0,

  // --- detection tuning (forwarded live to the worklet) ---
  detectionParams: { ...DEFAULT_DETECTION_PARAMS },

  // --- post-meal flow ---
  showCheckIn: false,
  lastSessionId: null,

  // --- debug / tuning ---
  showDebug: false,
  debugEvents: [], // recent accepted + rejected candidates (newest first)
  peakLevel: 0, // running peak RMS, for scaling the meter

  toggleDebug: () => set((s) => ({ showDebug: !s.showDebug })),

  setPaceCeiling: (n) => set({ paceCeiling: n }),
  setAccelTolerance: (n) => set({ accelTolerance: n }),

  /** Live-update one or more detection parameters in the worklet. */
  setDetectionParam: (key, value) => {
    const detectionParams = { ...get().detectionParams, [key]: value };
    set({ detectionParams });
    engine?.setParams({ [key]: value });
  },

  /** Current personalized overpace target (swallows/min). */
  effectiveTarget: () => {
    const { baselineRate, accelTolerance, paceCeiling } = get();
    return effectiveTargetRate(baselineRate, accelTolerance, paceCeiling);
  },

  isOverpace: () => {
    const { rate } = get();
    return rate >= MIN_MEANINGFUL_RATE && rate > get().effectiveTarget();
  },

  /** Pace zone for color coding: green / orange / red. */
  paceZone: () => {
    const { rate } = get();
    const target = get().effectiveTarget();
    if (rate < MIN_MEANINGFUL_RATE) return 'good';
    if (rate >= target) return 'over';
    if (rate >= target * 0.85) return 'warn';
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
      baselineRate: null,
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
            // Adaptive baseline/threshold drift over the session — keep the
            // meter markers in sync with the worklet's current values.
            calibration: s.calibration
              ? { ...s.calibration, baseline: msg.baseline, threshold: msg.threshold }
              : s.calibration,
          })),
        onSwallow: (msg) => get()._onSwallow(msg),
        onRejected: (msg) => get()._onRejected(msg),
      },
      {
        // processorOptions forwarded into the worklet
        ...get().detectionParams,
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

    const swallowCount = state.swallowCount + 1;
    const target = effectiveTargetRate(
      state.baselineRate,
      state.accelTolerance,
      state.paceCeiling
    );

    let overpaceEvents = state.overpaceEvents;
    if (rate >= MIN_MEANINGFUL_RATE && rate > target) {
      overpaceEvents += 1;
      overpaceFeedback();
    }

    set({
      swallowTimes: times,
      swallowCount,
      rate,
      overpaceEvents,
      baselineRate: learnBaseline(state.baselineRate, rate, swallowCount, target),
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
          baselineRate: state.baselineRate,
          paceCeiling: state.paceCeiling,
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
