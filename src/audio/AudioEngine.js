/**
 * AudioEngine.js
 *
 * Main-thread orchestration of the swallow-detection audio pipeline:
 *
 *   getUserMedia → MediaStreamSource → highpass(300Hz) → lowpass(2500Hz)
 *                → AudioWorkletNode('swallow-processor')
 *
 * The band-pass is built from two BiquadFilterNodes (a 300 Hz high-pass and a
 * 2500 Hz low-pass) on the main audio graph. The worklet receives the filtered
 * signal and runs RMS + the event-detection state machine off-thread.
 *
 * iOS-critical behavior:
 *   - The AudioContext is constructed lazily inside `start()`, which must be
 *     called from a user-gesture handler (the START button tap).
 *   - `resume()` is exposed and also wired to `visibilitychange` so the context
 *     restarts after a screen lock / tab switch.
 *
 * The worklet module URL is resolved with `new URL(..., import.meta.url)` so
 * Vite emits it as a hashed asset that works in both dev and production.
 */

// Vite resolves this to the served/emitted worklet asset URL.
const workletUrl = new URL('./swallow-processor.js', import.meta.url);

export const EngineState = {
  IDLE: 'idle',
  REQUESTING: 'requesting', // asking for mic permission
  CALIBRATING: 'calibrating', // sampling ambient noise
  RUNNING: 'running', // listening for swallows
  ERROR: 'error',
};

export class AudioEngine {
  /**
   * @param {object} handlers
   * @param {(e:object)=>void} [handlers.onSwallow]   detected swallow event
   * @param {(e:object)=>void} [handlers.onCalibrated] calibration finished
   * @param {(e:object)=>void} [handlers.onLevel]      live RMS level stream
   * @param {(s:string)=>void} [handlers.onState]      engine state change
   * @param {(err:object)=>void} [handlers.onError]    fatal/permission errors
   * @param {object} [options] processorOptions forwarded to the worklet
   */
  constructor(handlers = {}, options = {}) {
    this.handlers = handlers;
    this.options = options;

    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.highpass = null;
    this.lowpass = null;
    this.workletNode = null;

    this.state = EngineState.IDLE;
    this._onVisibility = this._onVisibility.bind(this);
  }

  _setState(s) {
    this.state = s;
    this.handlers.onState?.(s);
  }

  _emitError(code, message, raw) {
    this._setState(EngineState.ERROR);
    this.handlers.onError?.({ code, message, raw });
  }

  /**
   * Begin a session. MUST be invoked from within a user-gesture handler on iOS
   * so the AudioContext is allowed to start.
   */
  async start() {
    if (this.state === EngineState.RUNNING || this.state === EngineState.CALIBRATING) {
      return;
    }

    // --- 1. Permission / capture ---
    if (!navigator.mediaDevices?.getUserMedia) {
      this._emitError('unsupported', 'This browser does not support microphone capture.');
      return;
    }

    this._setState(EngineState.REQUESTING);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Disable browser cleanup so our DSP sees the raw signal.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      this._handleGumError(err);
      return;
    }

    // --- 2. AudioContext (created inside the gesture-driven call) ---
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      // iOS may hand back a suspended context even from a gesture.
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }

      await this.ctx.audioWorklet.addModule(workletUrl);
    } catch (err) {
      this._emitError('init', 'Failed to initialize the audio engine.', err);
      this._teardownStream();
      return;
    }

    // --- 3. Build the graph ---
    try {
      this.source = this.ctx.createMediaStreamSource(this.stream);

      this.highpass = this.ctx.createBiquadFilter();
      this.highpass.type = 'highpass';
      this.highpass.frequency.value = 300;
      this.highpass.Q.value = 0.707;

      this.lowpass = this.ctx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = 2500;
      this.lowpass.Q.value = 0.707;

      this.workletNode = new AudioWorkletNode(this.ctx, 'swallow-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: this.options,
      });

      this.workletNode.port.onmessage = (e) => this._onWorkletMessage(e.data);

      // source → highpass → lowpass → worklet
      this.source.connect(this.highpass);
      this.highpass.connect(this.lowpass);
      this.lowpass.connect(this.workletNode);
    } catch (err) {
      this._emitError('graph', 'Failed to build the audio graph.', err);
      this.stop();
      return;
    }

    document.addEventListener('visibilitychange', this._onVisibility);
    this._setState(EngineState.CALIBRATING);
  }

  _onWorkletMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case 'calibrated':
        this._setState(EngineState.RUNNING);
        this.handlers.onCalibrated?.(msg);
        break;
      case 'swallow':
        this.handlers.onSwallow?.(msg);
        break;
      case 'level':
        this.handlers.onLevel?.(msg);
        break;
      case 'rejected':
        this.handlers.onRejected?.(msg);
        break;
      case 'ready':
      default:
        break;
    }
  }

  _handleGumError(err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      this._emitError(
        'permission-denied',
        'Microphone access was blocked. Enable it in your browser settings and try again.',
        err
      );
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      this._emitError('no-device', 'No usable microphone was found.', err);
    } else if (name === 'NotReadableError') {
      this._emitError(
        'device-busy',
        'The microphone is in use by another app. Close it and retry.',
        err
      );
    } else {
      this._emitError('mic-error', 'Could not access the microphone.', err);
    }
    this._teardownStream();
  }

  _onVisibility() {
    if (document.visibilityState === 'visible') {
      this.resume();
    }
  }

  /** Resume after a screen lock / tab switch (also called on visibilitychange). */
  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* best effort */
      }
    }
  }

  /** Ask the worklet to re-sample ambient noise and recompute the threshold. */
  recalibrate() {
    if (this.workletNode) {
      this._setState(EngineState.CALIBRATING);
      this.workletNode.port.postMessage({ type: 'recalibrate' });
    }
  }

  /** Live-update detection parameters in the worklet (no restart). */
  setParams(params) {
    this.workletNode?.port.postMessage({ type: 'setParams', params });
  }

  _teardownStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  /** Stop the session and release all audio resources. */
  async stop() {
    document.removeEventListener('visibilitychange', this._onVisibility);

    try {
      this.source?.disconnect();
      this.highpass?.disconnect();
      this.lowpass?.disconnect();
      this.workletNode?.disconnect();
    } catch {
      /* ignore */
    }

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode = null;
    }

    this._teardownStream();

    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }

    this.source = this.highpass = this.lowpass = null;
    this._setState(EngineState.IDLE);
  }
}
