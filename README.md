# Gas Level: cooking gas cylinder monitor

An app that tells you how much LPG (cooking gas) is left in the cylinders
commonly used in Nigerian homes (3, 5, 6, 12.5, 25 and 50 kg). It also
predicts when the gas will run out and what a refill will cost.

## How it detects the gas level

LPG is stored in the cylinder as a **liquid under pressure**. The pressure stays
about the same until the cylinder is nearly empty, so a pressure gauge can't
tell you how much gas is left. **Weight** can:

```
gas left (kg) = cylinder weight now − tare weight (TW)
```

Every cylinder has its empty weight stamped on the metal collar around the
valve, marked **TW** (tare weight). A 12.5 kg cylinder with TW 14.5 that weighs
20.75 kg has 6.25 kg (50%) of gas left.

There are two ways to get the weight into the app:

1. **Manual (no hardware).** Weigh the cylinder with a bathroom scale (weigh
   yourself, then yourself holding the cylinder, and subtract) and type the
   number in.
2. **Smart scale (automatic).** Build a small ESP32 + load cell platform that
   the cylinder stands on all the time. See [`firmware/`](#smart-scale-hardware).

## The app (`gas-app/`)

An offline web app (PWA) with no build step and no server-side code. You can add it to your phone's home screen.

- Pick your cylinder size, enter the TW and the price per kg in ₦
- Shows a gauge with % and kg of gas left, colour-coded good / half / low / empty
- Learns how fast you use gas from your readings. It works out kg per day and
  predicts the date the gas runs out. When the weight jumps up, it treats that
  as a refill and starts a new cycle.
- Estimates the refill cost
- Sends a low-gas notification when you drop below your chosen threshold
- Keeps a history of readings on the device (localStorage)

Run it locally:

```bash
cd gas-app
npm start        # serves on http://localhost:8080
npm test         # unit tests for the gas maths (Node 18+)
```

To use it on a phone, host the `gas-app/` folder on any static host (for example GitHub
Pages or Netlify). Then open it in Chrome and choose "Add to Home screen".

## Smart scale hardware

`firmware/esp32_gas_scale/esp32_gas_scale.ino`

| Part | Approx. use |
|------|-------------|
| ESP32 dev board | Wi-Fi + web server |
| HX711 amplifier | Reads the load cell |
| Load cell, 50 kg (or 4× 50 kg half-bridge cells for a platform) | Weighs the cylinder (use 100–200 kg for a 50 kg cylinder) |
| Two flat boards / plywood platform | Cylinder stands on top |
| 5 V USB phone charger | Power |

Wiring: HX711 `DT` to GPIO16, `SCK` to GPIO4, `VCC` to 3.3 V, `GND` to GND.

Setup:
1. In the sketch, set `CYLINDER_CAPACITY_KG` and `CYLINDER_TARE_KG` (the TW).
2. Install the **HX711** library by Bogdan Necula and flash the sketch to the ESP32.
3. With the platform **empty**, power it on (or open `/tare`) to zero it.
4. Calibrate: put a known weight on it (e.g. a 10 kg bag of rice). Adjust
   `CALIBRATION_FACTOR` until the Serial Monitor shows the right weight.
5. Connect your phone to the Wi-Fi network **GasScale** (password `cookgas123`)
   and open `http://192.168.4.1` to see the level.

The scale also exposes `http://192.168.4.1/weight` as JSON. The app's
"Read from smart scale" button reads it. Browsers block an `https://` page from
calling an `http://` device, so for that button, open the app over plain
`http://` (for example `npm start` on a laptop on the same network). The scale's
own page at `192.168.4.1` always works.

## Safety

- Keep the electronics **under** the platform and away from the valve. Don't
  put anything with a spark near a leaking cylinder.
- The scale only measures weight. It does **not** detect leaks. If you smell
  gas, close the valve, open windows, don't switch anything on or off, and get
  the cylinder checked.
