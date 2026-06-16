# Intero necklace — v0 firmware

Streams the throat-mic signal from a **Seeed XIAO nRF52840 Sense** to the Intero
web app over Bluetooth LE, so the existing detection pipeline can run on real
necklace audio.

> ⚠️ **Prototype.** This sketch has not been compiled/flashed from this repo.
> Treat it as a starting point; expect to tune gain, chunk size, and connection
> parameters on real hardware.

## What it does

```
PDM mic (16 kHz) ──decimate→ 8 kHz int16 PCM ──BLE (Nordic UART)──▶ web app
                                                                     │
                                            ble-source worklet ──────┘
                                                   │
                            highpass 300 Hz → lowpass 2500 Hz → swallow detector
```

8 kHz keeps BLE bandwidth at ~128 kbps and power low, while staying well above
the 2.5 kHz top of the swallow band.

## Hardware

- **Seeed Studio XIAO nRF52840 _Sense_** — the **Sense** variant is required (it
  has the PDM mic + IMU; the plain XIAO nRF52840 has neither). On DigiKey,
  Mouser, or seeedstudio.com.
- LiPo battery (100–250 mAh) on the board's battery pads, or just USB power for bench tests
- Optional: a piezo **contact mic** pressed to the throat for better SNR than the
  on-board air mic (would replace the PDM path — not wired in this v0)

### Parts already on hand (prior DigiKey order — reusable here)

| Part | Role | Notes |
| --- | --- | --- |
| LiPo 3.7V 2800 mAh (Jameco) | Bench power | ⚠️ Too large for a discreet pendant (that needs ~100–250 mAh) — bench/prototype only. Verify polarity against the XIAO `BAT+`/`BAT-` pads before connecting; reverse polarity can destroy the board. The XIAO charges single-cell LiPo over USB, so no external charger needed. |
| JST PH 2-pin cable (Adafruit 261) | Battery → board | Confirm the cell's connector is JST PH 2.0 or rewire carefully. |
| SEGGER J-Link EDU Mini | SWD flash/debug | Optional — the XIAO flashes over USB. Handy for stepping through firmware. |
| Tag-Connect TC2030-CTX | SWD programming | Only for a **future custom PCB** that has a Tag-Connect footprint; not needed for the dev board. |
| TPS61023 5V boost | — | Not needed; the XIAO runs directly off the 3.7V LiPo. |

> Not reusable for Intero: the H2 / CH4 / MICS-5524 gas sensors and the SHT40
> humidity/temp sensor are from a different (environmental) project and have no
> role in swallow sensing.

## Toolchain

1. Install the **Arduino IDE**.
2. Add the Seeed nRF52 board package: Preferences → *Additional Boards Manager
   URLs* →
   `https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json`
3. Boards Manager → install **Seeed nRF52 mbed-enabled Boards** (provides the
   `bluefruit` and `PDM` libraries used here).
4. Select board: **Seeed XIAO nRF52840 Sense**.

## Flash

1. Open `intero_necklace_v0/intero_necklace_v0.ino`.
2. Plug in the XIAO; double-tap **RESET** to enter the bootloader if needed.
3. Upload. On success it advertises as **`Intero-Necklace`**.

## Connect from the app

1. Open the Intero web app in **desktop or Android Chrome** (Web Bluetooth — not
   iOS Safari).
2. Open the **debug** panel → **⬡ Connect necklace** → pick `Intero-Necklace`.
3. The necklace audio now drives the live detector. Calibration runs for the
   first 3 s exactly like the mic path, then it detects swallows + chewing.

## BLE contract (keep in sync with `src/audio/necklaceLink.js`)

- Service: Nordic UART Service `6e400001-…`
- TX characteristic (notify, device→app): `6e400003-…`
- Payload: raw little-endian `int16` PCM at **8 kHz**, mono, ~120 samples/packet

## Known v0 limitations / next steps

- **Throughput:** ~128 kbps is fine for BLE 5, but enable Data Length Extension
  and a short connection interval if you see dropouts. Underruns just produce
  brief silence (harmless for detection).
- **Coupling:** an air mic at chest height is weak — move the sensor toward the
  throat or switch to a contact mic for real SNR.
- **Power:** streaming raw audio is the battery cost. The lower-power path is
  on-device detection (port the classical pipeline to C, send only events).
- **iOS:** Web Bluetooth can't reach this. The iOS path is a native (Capacitor)
  wrapper using Core Bluetooth with the same BLE contract.
