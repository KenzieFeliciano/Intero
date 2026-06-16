/*
 * intero_necklace_v0.ino
 *
 * Intero swallow-necklace — v0 firmware for the Seeed Studio XIAO nRF52840
 * Sense. Captures the on-board PDM MEMS microphone, decimates to 8 kHz mono
 * 16-bit PCM, and streams it over BLE (Nordic UART Service) to the Intero web
 * app, which runs the existing 300-2500 Hz band-pass + swallow detector.
 *
 * Why 8 kHz: the swallow band tops out at ~2.5 kHz, so 8 kHz sampling is well
 * above Nyquist and keeps BLE bandwidth (~128 kbps) and power low. Don't stream
 * the full 16 kHz PDM rate — you'd burn battery for inaudible-to-us bandwidth.
 *
 * THIS IS A PROTOTYPE SKETCH — it has not been compiled/flashed in this repo.
 * See README.md for libraries, wiring, and flashing steps.
 *
 * Board:   Seeed XIAO nRF52840 Sense  (Seeed nRF52 mbed-enabled boards)
 * Library: Adafruit Bluefruit (bundled with the Seeed nRF52 core), PDM (built-in)
 */

#include <PDM.h>
#include <bluefruit.h>

// --- Audio config -------------------------------------------------------
static const int   PDM_RATE      = 16000; // PDM hardware sample rate
static const int   DECIMATE      = 2;      // 16k -> 8k
static const int   OUT_RATE      = PDM_RATE / DECIMATE; // 8000 Hz
static const int   BLE_CHUNK     = 120;    // int16 samples per notification (240 B)

// PDM double buffer (samples are int16). Sized for one PDM callback.
static int16_t  pdmBuf[512];
static volatile int pdmCount = 0;

// Output ring of decimated samples awaiting BLE transmit.
static int16_t  outBuf[BLE_CHUNK];
static int      outIdx = 0;
static int      decPhase = 0;
static long     decAcc = 0;

// --- BLE (Nordic UART Service) -----------------------------------------
BLEUart bleuart;

void onPDMData() {
  int bytes = PDM.available();
  PDM.read(pdmBuf, bytes);
  pdmCount = bytes / 2; // int16 count
}

void startBLE() {
  Bluefruit.begin();
  Bluefruit.setName("Intero-Necklace");
  Bluefruit.setTxPower(4);

  bleuart.begin();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0); // 0 = advertise forever
}

void setup() {
  // Mono, 16 kHz PDM.
  PDM.onReceive(onPDMData);
  PDM.setGain(40); // tune for your enclosure / skin coupling
  if (!PDM.begin(1, PDM_RATE)) {
    // If this fails the mic isn't available — halt visibly.
    while (1) { delay(1000); }
  }
  startBLE();
}

void loop() {
  if (pdmCount == 0) return;

  int n = pdmCount;
  pdmCount = 0;

  for (int i = 0; i < n; i++) {
    // Box-average decimation (cheap anti-alias) by factor DECIMATE.
    decAcc += pdmBuf[i];
    if (++decPhase >= DECIMATE) {
      int16_t s = (int16_t)(decAcc / DECIMATE);
      decAcc = 0;
      decPhase = 0;

      outBuf[outIdx++] = s;
      if (outIdx >= BLE_CHUNK) {
        if (Bluefruit.connected()) {
          bleuart.write((uint8_t *)outBuf, BLE_CHUNK * sizeof(int16_t));
        }
        outIdx = 0;
      }
    }
  }
}
