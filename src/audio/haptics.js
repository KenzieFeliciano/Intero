/**
 * haptics.js
 *
 * Overpace feedback. `navigator.vibrate()` is unsupported on iOS Safari, so we
 * fall back to a short, low-volume 440 Hz beep synthesized with a dedicated
 * AudioContext. The fallback context is created lazily on first use — which, in
 * practice, happens after the user has already tapped START, so it is allowed
 * to produce sound on iOS.
 */

let toneCtx = null;
let lastFeedback = 0;

function getToneCtx() {
  if (!toneCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    toneCtx = new Ctx();
  }
  if (toneCtx.state === 'suspended') {
    toneCtx.resume().catch(() => {});
  }
  return toneCtx;
}

export const canVibrate =
  typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

/** Short low-volume 440 Hz beep — the iOS-safe fallback for haptics. */
export function beep({ frequency = 440, durationMs = 160, volume = 0.06 } = {}) {
  const ctx = getToneCtx();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.value = frequency;

  // Quick attack/decay envelope to avoid clicks.
  const now = ctx.currentTime;
  const dur = durationMs / 1000;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume, now + 0.01);
  gain.gain.setValueAtTime(volume, now + dur - 0.03);
  gain.gain.linearRampToValueAtTime(0, now + dur);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

/**
 * Trigger overpace feedback: vibrate where supported, otherwise beep. Rate-
 * limited so a sustained overpace doesn't buzz continuously.
 * @param {object} [opts]
 * @param {number[]} [opts.pattern] vibration pattern (ms)
 * @param {number} [opts.minGapMs] minimum spacing between cues
 */
export function overpaceFeedback({ pattern = [120], minGapMs = 1500 } = {}) {
  const now = Date.now();
  if (now - lastFeedback < minGapMs) return;
  lastFeedback = now;

  if (canVibrate) {
    try {
      navigator.vibrate(pattern);
      return;
    } catch {
      /* fall through to beep */
    }
  }
  beep();
}

/** Prime the fallback AudioContext from within a user gesture (START tap). */
export function primeHaptics() {
  getToneCtx();
}
