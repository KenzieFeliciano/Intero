/**
 * swallow-processor.js
 *
 * AudioWorkletProcessor that detects swallow events from a band-pass-filtered
 * microphone stream. The band-pass (300–2500 Hz) is applied UPSTREAM on the
 * main-thread audio graph via two BiquadFilterNodes, so by the time samples
 * arrive here they are already filtered. This processor is responsible for:
 *
 *   1. RMS energy computation in fixed ~50 ms windows.
 *   2. Ambient-noise calibration: average the first N seconds of RMS to learn
 *      a baseline, then set the detection threshold at `thresholdMultiplier`×.
 *   3. A 4-state event-detection machine: SILENT → RISING → PEAK → FALLING.
 *      A swallow fires when a rise/peak/fall completes with total duration in
 *      [minDuration, maxDuration] ms, subject to a minimum inter-event gap.
 *
 * Detected events are posted to the main thread via `this.port.postMessage`.
 *
 * No external libraries — pure DSP. Self-contained (no imports) so it can be
 * loaded directly as an AudioWorklet module.
 */

const STATE = {
  SILENT: 'SILENT',
  RISING: 'RISING',
  PEAK: 'PEAK',
  FALLING: 'FALLING',
};

class SwallowProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = (options && options.processorOptions) || {};

    // --- Tunable parameters (all overridable from the main thread) ---
    this.windowMs = opts.windowMs ?? 50; // RMS integration window
    this.calibrationMs = opts.calibrationMs ?? 3000; // ambient sampling period
    this.thresholdMultiplier = opts.thresholdMultiplier ?? 3.5; // 3–4× baseline
    this.minDuration = opts.minDuration ?? 200; // ms — shortest valid swallow
    this.maxDuration = opts.maxDuration ?? 900; // ms — longest valid swallow
    this.minInterval = opts.minInterval ?? 2000; // ms — refractory period
    // Release at a fraction of threshold to add hysteresis (avoids chatter).
    this.releaseRatio = opts.releaseRatio ?? 0.6;
    // Abort a stuck event if it runs much longer than a real swallow could.
    this.maxEventMs = opts.maxEventMs ?? 1500;
    // A floor so a dead-silent room doesn't produce a near-zero threshold.
    this.minBaseline = opts.minBaseline ?? 1e-4;
    // EMA smoothing of the RMS stream (0–1). Light smoothing knocks down
    // single-window jitter without flattening the swallow's peak. 1 = off.
    this.emaAlpha = opts.emaAlpha ?? 0.6;
    // Adaptive noise floor: how fast the baseline tracks ambient drift during
    // quiet windows (per 50 ms window). 0 = frozen at initial calibration.
    this.adaptRate = opts.adaptRate ?? 0.02;
    // Reject candidates whose peak doesn't clear the baseline by this factor,
    // independent of the absolute threshold. Guards against loud-but-flat rooms.
    this.minSnr = opts.minSnr ?? 2.0;

    // Smoothed RMS used by the detector.
    this.smoothed = 0;

    // --- Chewing (mastication) detection -------------------------------
    // Chewing is a SUSTAINED, RHYTHMIC train of mid-band energy bumps (jaw
    // cycles ~1–2 Hz), unlike a swallow's single transient. We count energy
    // "bumps" above a lower chew threshold within a trailing window; enough of
    // them, spread over time, means the user is actively chewing — which in
    // turn lets us tag the following swallow as food (vs. water/saliva).
    this.chewThresholdMult = opts.chewThresholdMult ?? 2.0; // < swallow's mult
    this.chewWindowMs = opts.chewWindowMs ?? 4000; // trailing window for bumps
    this.minChewBumps = opts.minChewBumps ?? 4; // bumps needed to call it chewing
    this.chewHoldMs = opts.chewHoldMs ?? 1500; // keep "chewing" this long after
    this.chewContextMs = opts.chewContextMs ?? 2500; // swallow within = food

    this.chewBumpTimes = []; // recent bump onset times (ms)
    this.aboveChew = false; // hysteresis edge tracking for bump onsets
    this.chewing = false;
    this.lastChewActiveTime = -Infinity; // last time chewing was active

    // --- Optional raw-capture for the record/replay tuning loop ---
    this.recording = false;
    this.recordChunks = []; // array of Float32Array frames while recording

    // --- Windowing state ---
    this.windowSamples = Math.max(1, Math.round((sampleRate * this.windowMs) / 1000));
    this.windowAcc = 0; // sum of squares in the current window
    this.windowCount = 0; // samples accumulated in the current window

    // --- Calibration state ---
    this.calibrating = true;
    this.calWindowsNeeded = Math.max(1, Math.round(this.calibrationMs / this.windowMs));
    this.calSamples = []; // collected per-window RMS values
    this.baseline = 0;
    this.threshold = Infinity; // until calibrated, nothing fires
    this.releaseThreshold = Infinity;

    // --- Detection state machine ---
    this.state = STATE.SILENT;
    this.onsetTime = 0; // ms, when energy first crossed threshold
    this.peakRms = 0;
    this.peakTime = 0;
    this.lastEventTime = -Infinity;

    // A monotonic clock in ms derived from processed sample count. We avoid
    // currentTime drift by counting windows ourselves.
    this.elapsedMs = 0;

    this.port.postMessage({ type: 'ready', sampleRate, windowSamples: this.windowSamples });

    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'recalibrate') {
        this._resetCalibration();
      } else if (msg.type === 'setParams' && msg.params) {
        this._setParams(msg.params);
      } else if (msg.type === 'startRecording') {
        this.recordChunks = [];
        this.recording = true;
      } else if (msg.type === 'stopRecording') {
        this._flushRecording();
      }
    };
  }

  /** Concatenate captured frames and ship them to the main thread. */
  _flushRecording() {
    this.recording = false;
    let total = 0;
    for (const c of this.recordChunks) total += c.length;
    const samples = new Float32Array(total);
    let offset = 0;
    for (const c of this.recordChunks) {
      samples.set(c, offset);
      offset += c.length;
    }
    this.recordChunks = [];
    // Transfer the underlying buffer to avoid a copy.
    this.port.postMessage({ type: 'recording', samples, sampleRate }, [samples.buffer]);
  }

  /** Live-update tunable parameters from the UI (no restart needed). */
  _setParams(p) {
    const tunable = [
      'thresholdMultiplier',
      'minDuration',
      'maxDuration',
      'minInterval',
      'releaseRatio',
      'emaAlpha',
      'adaptRate',
      'minSnr',
      'chewThresholdMult',
      'minChewBumps',
    ];
    for (const k of tunable) {
      if (typeof p[k] === 'number' && Number.isFinite(p[k])) this[k] = p[k];
    }
    if (!this.calibrating) this._applyThreshold();
  }

  _resetCalibration() {
    this.calibrating = true;
    this.calSamples = [];
    this.baseline = 0;
    this.threshold = Infinity;
    this.releaseThreshold = Infinity;
    this.state = STATE.SILENT;
    this.smoothed = 0;
    this.chewBumpTimes = [];
    this.aboveChew = false;
    this.chewing = false;
    this.lastChewActiveTime = -Infinity;
  }

  _applyThreshold() {
    this.threshold = this.baseline * this.thresholdMultiplier;
    this.releaseThreshold = this.threshold * this.releaseRatio;
  }

  _finishCalibration() {
    // Robust baseline: median of collected window RMS values. Median rejects
    // the occasional clink/cough during the ambient sampling window.
    const sorted = this.calSamples.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    this.baseline = Math.max(median, this.minBaseline);
    this.smoothed = this.baseline; // seed the EMA so detection starts settled
    this.calibrating = false;
    this._applyThreshold();

    this.port.postMessage({
      type: 'calibrated',
      baseline: this.baseline,
      threshold: this.threshold,
      windows: this.calSamples.length,
    });
  }

  /**
   * Fed one RMS value per ~50 ms window. Drives the state machine and emits
   * swallow events.
   */
  _onWindow(rawRms) {
    this.elapsedMs += this.windowMs;
    const now = this.elapsedMs;

    // Exponential moving average to suppress single-window jitter.
    this.smoothed = this.emaAlpha * rawRms + (1 - this.emaAlpha) * this.smoothed;
    const rms = this.smoothed;

    if (this.calibrating) {
      this.calSamples.push(rawRms);
      if (this.calSamples.length >= this.calWindowsNeeded) {
        this._finishCalibration();
      }
      return;
    }

    // Adaptive noise floor: while genuinely quiet, let the baseline drift
    // toward the ambient level so the threshold follows a changing room (an AC
    // kicking on, a noisier restaurant) instead of staying frozen at startup.
    if (this.state === STATE.SILENT && rms < this.threshold) {
      this.baseline = (1 - this.adaptRate) * this.baseline + this.adaptRate * rms;
      this.baseline = Math.max(this.baseline, this.minBaseline);
      this._applyThreshold();
    }

    // Chewing detection runs in parallel on the raw (un-smoothed) stream.
    this._detectChew(rawRms, now);

    // Stream both raw and smoothed levels out for visualization / debugging.
    this.port.postMessage({
      type: 'level',
      rms,
      raw: rawRms,
      threshold: this.threshold,
      baseline: this.baseline,
      t: now,
      state: this.state,
    });

    switch (this.state) {
      case STATE.SILENT: {
        if (rms > this.threshold) {
          this.state = STATE.RISING;
          this.onsetTime = now;
          this.peakRms = rms;
          this.peakTime = now;
        }
        break;
      }

      case STATE.RISING: {
        if (rms >= this.peakRms) {
          // still climbing
          this.peakRms = rms;
          this.peakTime = now;
        } else {
          // energy turned over — we've found the peak
          this.state = STATE.PEAK;
        }
        this._guardTimeout(now);
        break;
      }

      case STATE.PEAK: {
        // Transient apex; on any further sample decide rise vs. fall.
        if (rms >= this.peakRms) {
          this.peakRms = rms;
          this.peakTime = now;
          this.state = STATE.RISING; // second wind, keep climbing
        } else {
          this.state = STATE.FALLING;
        }
        this._guardTimeout(now);
        break;
      }

      case STATE.FALLING: {
        if (rms >= this.peakRms) {
          // bounced back up — treat as a new rise
          this.state = STATE.RISING;
          this.peakRms = rms;
          this.peakTime = now;
        } else if (rms <= this.releaseThreshold) {
          // returned to baseline — the event is complete
          this._evaluateEvent(now);
          this.state = STATE.SILENT;
        }
        this._guardTimeout(now);
        break;
      }

      default:
        this.state = STATE.SILENT;
    }
  }

  _guardTimeout(now) {
    if (now - this.onsetTime > this.maxEventMs) {
      // Stuck/over-long excursion — discard and resync to silence.
      this.state = STATE.SILENT;
    }
  }

  /**
   * Update chewing state from the raw RMS stream. Counts energy bumps (rising
   * crossings of the chew threshold) within a trailing window; a sustained
   * rhythmic train of them = chewing. Runs in parallel with swallow detection.
   */
  _detectChew(rawRms, now) {
    const chewThreshold = this.baseline * this.chewThresholdMult;

    // Rising-edge bump detection with hysteresis (release at 0.7×).
    if (!this.aboveChew && rawRms > chewThreshold) {
      this.aboveChew = true;
      this.chewBumpTimes.push(now);
    } else if (this.aboveChew && rawRms < chewThreshold * 0.7) {
      this.aboveChew = false;
    }

    // Drop bumps older than the trailing window.
    const cutoff = now - this.chewWindowMs;
    while (this.chewBumpTimes.length && this.chewBumpTimes[0] < cutoff) {
      this.chewBumpTimes.shift();
    }

    const rhythmic = this.chewBumpTimes.length >= this.minChewBumps;
    let chewing;
    if (rhythmic) {
      this.lastChewActiveTime = now;
      chewing = true;
    } else {
      // Hold the chewing state briefly so a between-cycle gap doesn't flicker.
      chewing = now - this.lastChewActiveTime < this.chewHoldMs;
    }

    if (chewing !== this.chewing) {
      this.chewing = chewing;
      this.port.postMessage({ type: 'chewing', active: chewing, t: now });
    }
  }

  _evaluateEvent(offsetTime) {
    const duration = offsetTime - this.onsetTime;
    const sinceLast = offsetTime - this.lastEventTime;
    const snr = this.peakRms / this.baseline;
    // Food context: was the user chewing just before this swallow?
    const chewRecent =
      this.chewing || offsetTime - this.lastChewActiveTime <= this.chewContextMs;

    const durationOk = duration >= this.minDuration && duration <= this.maxDuration;
    const intervalOk = sinceLast >= this.minInterval;
    const snrOk = snr >= this.minSnr;

    if (durationOk && intervalOk && snrOk) {
      this.lastEventTime = offsetTime;
      this.port.postMessage({
        type: 'swallow',
        t: offsetTime,
        duration,
        peak: this.peakRms,
        baseline: this.baseline,
        snr,
        chewRecent,
        // Heuristic label: chewing before → food; otherwise water/saliva.
        kind: chewRecent ? 'food' : 'liquid',
      });
    } else {
      // Surface rejected candidates — useful while tuning thresholds.
      const reason = !durationOk ? 'duration' : !snrOk ? 'snr' : 'interval';
      this.port.postMessage({ type: 'rejected', t: offsetTime, duration, snr, reason });
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    // Capture a copy of the (already band-pass-filtered) frame for replay.
    if (this.recording) this.recordChunks.push(channel.slice());

    for (let i = 0; i < channel.length; i++) {
      const s = channel[i];
      this.windowAcc += s * s;
      this.windowCount++;

      if (this.windowCount >= this.windowSamples) {
        const rms = Math.sqrt(this.windowAcc / this.windowCount);
        this.windowAcc = 0;
        this.windowCount = 0;
        this._onWindow(rms);
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('swallow-processor', SwallowProcessor);
