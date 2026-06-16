/**
 * necklaceLink.js — Web Bluetooth client for the Intero necklace prototype.
 *
 * The necklace (Seeed XIAO nRF52840 Sense, see /firmware) streams PCM audio as
 * BLE notifications. We use the Nordic UART Service (NUS) as a simple transport:
 * the firmware writes 16-bit little-endian samples to the TX characteristic, and
 * we decode them to Float32 and hand them to a consumer (the BLE-source worklet).
 *
 * PLATFORM: Web Bluetooth works on Android/desktop Chrome only — NOT iOS. This
 * is a development/prototyping bridge so you can drive the existing detection
 * pipeline from the necklace on a laptop. The shipping iOS path is a native
 * (Capacitor) wrapper using Core Bluetooth.
 */

// Nordic UART Service UUIDs.
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device → app (notify)

// Stream format the firmware emits (keep in sync with the sketch).
export const NECKLACE_SAMPLE_RATE = 8000;

export class NecklaceLink {
  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  /**
   * @param {object} handlers
   * @param {(samples:Float32Array)=>void} [handlers.onSamples]
   * @param {(connected:boolean, name?:string)=>void} [handlers.onConnection]
   * @param {(err:{message:string,raw?:any})=>void} [handlers.onError]
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.device = null;
    this.txChar = null;
    this._onDisconnected = this._onDisconnected.bind(this);
    this._onValue = this._onValue.bind(this);
  }

  /** Prompt for the necklace and start streaming. Must run in a user gesture. */
  async connect() {
    if (!NecklaceLink.supported) {
      this.handlers.onError?.({ message: 'Web Bluetooth is unavailable on this device.' });
      return false;
    }
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE] }, { namePrefix: 'Intero' }],
        optionalServices: [NUS_SERVICE],
      });
    } catch (err) {
      if (err?.name === 'NotFoundError') return false; // user cancelled
      this.handlers.onError?.({ message: 'Could not select the necklace.', raw: err });
      return false;
    }

    this.device.addEventListener('gattserverdisconnected', this._onDisconnected);
    try {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(NUS_SERVICE);
      this.txChar = await service.getCharacteristic(NUS_TX);
      this.txChar.addEventListener('characteristicvaluechanged', this._onValue);
      await this.txChar.startNotifications();
      this.handlers.onConnection?.(true, this.device.name || 'Intero necklace');
      return true;
    } catch (err) {
      this.handlers.onError?.({ message: 'Failed to connect to the necklace.', raw: err });
      this.disconnect();
      return false;
    }
  }

  _onValue(event) {
    const dv = event.target.value;
    // Decode 16-bit little-endian PCM → Float32 in [-1, 1).
    const n = dv.byteLength >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = dv.getInt16(i * 2, true) / 32768;
    }
    this.handlers.onSamples?.(out);
  }

  _onDisconnected() {
    this.txChar = null;
    this.handlers.onConnection?.(false);
  }

  async disconnect() {
    try {
      if (this.txChar) {
        this.txChar.removeEventListener('characteristicvaluechanged', this._onValue);
        await this.txChar.stopNotifications().catch(() => {});
      }
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
        if (this.device.gatt?.connected) this.device.gatt.disconnect();
      }
    } catch {
      /* best effort */
    }
    this.txChar = null;
    this.device = null;
    this.handlers.onConnection?.(false);
  }
}
