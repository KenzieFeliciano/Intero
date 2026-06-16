/**
 * tuning.js — helpers for the detection-tuning workflow:
 *   - persist/restore tuned detection parameters (localStorage),
 *   - encode a captured session to a downloadable WAV,
 *   - replay captured audio through the REAL detector offline so you can
 *     compare parameter sets without eating another meal.
 */

// Reuse the exact same worklet module the live engine uses.
const workletUrl = new URL('../audio/swallow-processor.js', import.meta.url);

const PARAMS_KEY = 'intero.detectionParams';

/** Load saved params merged over defaults (so new keys still get a default). */
export function loadParams(defaults) {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (!raw) return { ...defaults };
    const saved = JSON.parse(raw);
    return { ...defaults, ...saved };
  } catch {
    return { ...defaults };
  }
}

export function persistParams(params) {
  try {
    localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
  } catch {
    /* storage disabled / full — non-fatal */
  }
}

/**
 * Decode an audio File (WAV, and whatever else the browser supports) into mono
 * Float32 samples so it can be run through the replay harness — e.g. public
 * chewing/swallow clips from Freesound, no recording required.
 * @returns {Promise<{samples:Float32Array, sampleRate:number}>}
 */
export async function decodeAudioFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    // Downmix to mono.
    const ch = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / ch;
    }
    return { samples: mono, sampleRate: audioBuffer.sampleRate };
  } finally {
    ctx.close();
  }
}

/** Encode mono Float32 PCM as a 16-bit WAV Blob. */
export function encodeWav(samples, sampleRate) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}

/**
 * Run captured samples through the detector offline with the given params and
 * return the resulting counts. Because the capture is taken AFTER the band-pass
 * filters (it's exactly what the worklet sees live), we feed it straight into
 * the processor here — no need to re-apply the biquads.
 *
 * The processor declares zero outputs in the live graph, but an offline render
 * only pulls nodes that reach the destination, so here we instantiate it with
 * one (silent) output and connect it through.
 *
 * @returns {Promise<{swallows:number, rejected:number, events:object[]}>}
 */
export async function replayDetection(samples, sampleRate, params, { prefilter = false } = {}) {
  const length = samples.length;
  const offline = new OfflineAudioContext(1, length, sampleRate);
  await offline.audioWorklet.addModule(workletUrl);

  const buffer = offline.createBuffer(1, length, sampleRate);
  buffer.copyToChannel(samples, 0);

  const source = offline.createBufferSource();
  source.buffer = buffer;

  const node = new AudioWorkletNode(offline, 'swallow-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { ...params, calibrationMs: 3000 },
  });

  // Live captures are already band-passed (the worklet sits after the filters);
  // imported clips are raw, so apply the same 300–2500 Hz band-pass first.
  let head = source;
  if (prefilter) {
    const hp = offline.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.707;
    const lp = offline.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2500;
    lp.Q.value = 0.707;
    source.connect(hp);
    hp.connect(lp);
    head = lp;
  }

  let swallows = 0;
  let rejected = 0;
  const events = [];
  node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'swallow') {
      swallows++;
      events.push(m);
    } else if (m.type === 'rejected') {
      rejected++;
    }
  };

  head.connect(node);
  node.connect(offline.destination);
  source.start();

  await offline.startRendering();
  // Give queued port messages a tick to drain.
  await new Promise((r) => setTimeout(r, 0));

  return { swallows, rejected, events };
}
