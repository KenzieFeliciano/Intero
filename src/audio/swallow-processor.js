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
      } else if (msg.type === 'setThreshold' && typeof msg.value === 'number') {
        this.thresholdMultiplier = msg.value;
        if (!this.calibrating) this._applyThreshold();
      }
    };
  }

  _resetCalibration() {
    this.calibrating = true;
    this.calSamples = [];
    this.baseline = 0;
    this.threshold = Infinity;
    this.releaseThreshold = Infinity;
    this.state = STATE.SILENT;
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
  _onWindow(rms) {
    this.elapsedMs += this.windowMs;
    const now = this.elapsedMs;

    if (this.calibrating) {
      this.calSamples.push(rms);
      if (this.calSamples.length >= this.calWindowsNeeded) {
        this._finishCalibration();
      }
      return;
    }

    // Stream the live level out for visualization / debugging.
    this.port.postMessage({ type: 'level', rms, t: now, state: this.state });

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

  _evaluateEvent(offsetTime) {
    const duration = offsetTime - this.onsetTime;
    const sinceLast = offsetTime - this.lastEventTime;

    const durationOk = duration >= this.minDuration && duration <= this.maxDuration;
    const intervalOk = sinceLast >= this.minInterval;

    if (durationOk && intervalOk) {
      this.lastEventTime = offsetTime;
      this.port.postMessage({
        type: 'swallow',
        t: offsetTime,
        duration,
        peak: this.peakRms,
        baseline: this.baseline,
        snr: this.peakRms / this.baseline,
      });
    } else {
      // Surface rejected candidates — useful while tuning thresholds.
      this.port.postMessage({
        type: 'rejected',
        t: offsetTime,
        duration,
        reason: !durationOk ? 'duration' : 'interval',
      });
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

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
