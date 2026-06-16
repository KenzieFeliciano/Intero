/**
 * heartRate.js — optional heart-rate input via Web Bluetooth.
 *
 * Connects to any standard BLE Heart Rate sensor (chest straps like the Polar
 * H10, many fitness bands) using the GATT Heart Rate Service (0x180D) and its
 * Heart Rate Measurement characteristic (0x2A37).
 *
 * PROGRESSIVE ENHANCEMENT: Web Bluetooth is unavailable on iOS (every iOS
 * browser is WebKit, which doesn't implement it) and on Firefox. Callers must
 * feature-detect with `HeartRateMonitor.supported` and simply not render the
 * HR UI when it's false. Nothing here runs on an unsupported platform.
 *
 * `connect()` calls `navigator.bluetooth.requestDevice`, which — like
 * getUserMedia — MUST be invoked from a user gesture (a Connect button tap).
 */

const HEART_RATE_SERVICE = 'heart_rate'; // 0x180D
const HEART_RATE_MEASUREMENT = 'heart_rate_measurement'; // 0x2A37

/**
 * Parse the Heart Rate Measurement characteristic value per the BLE spec.
 * Flags byte bit 0 selects 8- vs 16-bit BPM; bits 1–2 are sensor contact;
 * bit 4 indicates trailing RR-interval values (useful for HRV later).
 * @param {DataView} value
 */
export function parseHeartRate(value) {
  const flags = value.getUint8(0);
  const is16bit = flags & 0x01;
  const contactSupported = flags & 0x04;
  const contactDetected = flags & 0x02;
  const hasEnergy = flags & 0x08;
  const hasRR = flags & 0x10;

  let offset = 1;
  let bpm;
  if (is16bit) {
    bpm = value.getUint16(offset, /* littleEndian */ true);
    offset += 2;
  } else {
    bpm = value.getUint8(offset);
    offset += 1;
  }

  if (hasEnergy) offset += 2; // skip Energy Expended (uint16)

  const rr = [];
  if (hasRR) {
    for (; offset + 1 < value.byteLength; offset += 2) {
      // RR-interval is in units of 1/1024 s.
      rr.push((value.getUint16(offset, true) / 1024) * 1000);
    }
  }

  return {
    bpm,
    rr, // ms between beats (may be empty)
    contact: contactSupported ? Boolean(contactDetected) : null,
    ts: Date.now(),
  };
}

export class HeartRateMonitor {
  /** Feature-detect. False on iOS, Firefox, and any non-HTTPS context. */
  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  /**
   * @param {object} handlers
   * @param {(m:{bpm:number,rr:number[],contact:?boolean,ts:number})=>void} [handlers.onMeasurement]
   * @param {(connected:boolean, deviceName?:string)=>void} [handlers.onConnection]
   * @param {(err:{message:string,raw?:any})=>void} [handlers.onError]
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.device = null;
    this.characteristic = null;
    this._onDisconnected = this._onDisconnected.bind(this);
    this._onValueChanged = this._onValueChanged.bind(this);
  }

  /** Prompt for a device and start streaming. Must run in a user gesture. */
  async connect() {
    if (!HeartRateMonitor.supported) {
      this.handlers.onError?.({ message: 'Web Bluetooth is not available on this device.' });
      return false;
    }

    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HEART_RATE_SERVICE] }],
        optionalServices: [HEART_RATE_SERVICE],
      });
    } catch (err) {
      // User cancelled the chooser, or no device — not a hard error.
      if (err?.name === 'NotFoundError') return false;
      this.handlers.onError?.({ message: 'Could not select a heart-rate device.', raw: err });
      return false;
    }

    this.device.addEventListener('gattserverdisconnected', this._onDisconnected);

    try {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(HEART_RATE_SERVICE);
      this.characteristic = await service.getCharacteristic(HEART_RATE_MEASUREMENT);
      this.characteristic.addEventListener('characteristicvaluechanged', this._onValueChanged);
      await this.characteristic.startNotifications();
      this.handlers.onConnection?.(true, this.device.name || 'Heart-rate sensor');
      return true;
    } catch (err) {
      this.handlers.onError?.({ message: 'Failed to connect to the heart-rate sensor.', raw: err });
      this.disconnect();
      return false;
    }
  }

  _onValueChanged(event) {
    try {
      this.handlers.onMeasurement?.(parseHeartRate(event.target.value));
    } catch {
      /* malformed packet — ignore */
    }
  }

  _onDisconnected() {
    this.characteristic = null;
    this.handlers.onConnection?.(false);
  }

  /** Stop notifications and drop the connection. */
  async disconnect() {
    try {
      if (this.characteristic) {
        this.characteristic.removeEventListener('characteristicvaluechanged', this._onValueChanged);
        await this.characteristic.stopNotifications().catch(() => {});
      }
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
        if (this.device.gatt?.connected) this.device.gatt.disconnect();
      }
    } catch {
      /* best effort */
    }
    this.characteristic = null;
    this.device = null;
    this.handlers.onConnection?.(false);
  }
}
