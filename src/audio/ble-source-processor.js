/**
 * ble-source-processor.js
 *
 * An AudioWorklet *source* that plays back PCM samples pushed from the main
 * thread (decoded from BLE notifications off the necklace). It lets us feed the
 * necklace's audio into the EXISTING graph unchanged:
 *
 *   ble-source → highpass(300Hz) → lowpass(2500Hz) → swallow-processor
 *
 * The AudioContext is created at the necklace's stream rate (e.g. 8 kHz), so
 * samples play out 1:1 with no resampling. A simple ring buffer absorbs the
 * burstiness of BLE packets; if it underruns we output silence (a brief gap is
 * harmless for swallow detection).
 */

class BleSourceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // Ring buffer sized for a few seconds of audio at the context rate.
    this.capacity = Math.max(sampleRate * (opts.bufferSeconds ?? 4), 4096);
    this.ring = new Float32Array(this.capacity);
    this.writeIdx = 0;
    this.readIdx = 0;
    this.available = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.type === 'samples' && msg.data) {
        this._write(msg.data);
      }
    };
  }

  _write(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.writeIdx] = samples[i];
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
      if (this.available < this.capacity) {
        this.available++;
      } else {
        // Overrun: advance read pointer (drop oldest) to stay current.
        this.readIdx = (this.readIdx + 1) % this.capacity;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    for (let i = 0; i < out.length; i++) {
      if (this.available > 0) {
        out[i] = this.ring[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;
      } else {
        out[i] = 0; // underrun → silence
      }
    }
    return true;
  }
}

registerProcessor('ble-source-processor', BleSourceProcessor);
