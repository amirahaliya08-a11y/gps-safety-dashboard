# Safehaven GPS Safety Dashboard

A standalone, responsive Vite + React + TypeScript prototype for an assistive safety monitoring dashboard. It demonstrates how a caregiver-facing view could present GPS location and fall-alert status for a deafblind person.

## Run locally

Requirements: Node.js 20.19+ or 22.12+.

```powershell
npm.cmd install
npm.cmd run dev
```

## Publish publicly with GitHub Pages

1. Create a GitHub repository and push this project to its `main` or `master` branch.
2. In the repository, open **Settings → Pages** and set the build and deployment source to **GitHub Actions**.
3. The included workflow builds and deploys the site on each push. When it completes, the public address appears in the workflow run or under **Settings → Pages**.

The deployment automatically uses the correct base path for either a project site or a user/organization site. The published site is publicly accessible. It does not invent sensor readings: live hardware values are shown only when received from a compatible ESP32. Do not publish private contact details or secrets.

## Collaborate with developers

Use Visual Studio Code Live Share to let invited developers edit this project with you in a real-time session. This does not require GitHub or a separate code-hosting repository.

1. Install the **Live Share** extension when VS Code recommends it, or install it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=MS-vsliveshare.vsliveshare).
2. Open this project folder in VS Code and choose **Live Share: Start Collaboration Session** from the Command Palette. Sign in to Live Share if prompted.
3. Copy the invitation link and send it only to developers you trust. They need VS Code and the Live Share extension to join.
4. Keep VS Code and your computer online while collaborating. Guests can edit the shared project files; their edits are made in your project folder.
5. To let guests preview the running website, start it with `npm.cmd run dev`, then share port `5173` from the Live Share session.
6. End the session from the Live Share menu when finished. The session link grants access while the session is active, so do not post it publicly.

Only share folders and terminals you intend collaborators to access. Do not place passwords, API secrets, or private `.env` files in the shared project. `.env` files are excluded from Git; only `.env.example` is intended to be shared. Vite variables prefixed with `VITE_` are included in the public website bundle, so never put secrets in them.

## Connect an ESP32 over Bluetooth

The dashboard uses the browser's Bluetooth picker, so there is no address to copy or enter:

1. Flash the ESP32 with BLE firmware that advertises the Nordic UART Service (NUS), reads the GPS and motion sensors, monitors battery/fall state, and monitors GSM, vibrator, LED, and sensing-electrode status locally.
2. Open the dashboard in Chrome or Edge on HTTPS or `localhost`, turn on Bluetooth, and press **Connect device**. Choose the ESP32 in the browser's Bluetooth prompt. The browser requires that device-selection step for privacy; a website cannot silently scan or pair with nearby devices.

The ESP32 firmware must expose the NUS service `6e400001-b5a3-f393-e0a9-e50e24dcca9e` and its TX notification characteristic `6e400003-b5a3-f393-e0a9-e50e24dcca9e`. Send UTF-8 JSON telemetry lines, each ending in a newline (`\n`). Notifications may split a line across multiple packets; the dashboard reassembles lines before parsing. Fields are optional so a device can report available readings while, for example, the GPS is still acquiring a fix:

```json
{
  "type": "telemetry",
  "timestamp": "2026-10-05T00:00:00Z",
  "gps": { "latitude": 2.9292, "longitude": 101.7839, "fix": true },
  "accelerometer": { "x": 0.1, "y": 0.2, "z": 9.8 },
  "gyroscope": { "x": 0.0, "y": 0.1, "z": 0.0 },
  "batteryPercent": 82,
  "fallDetected": false,
  "obstacleDetected": false,
  "buzzerActive": false,
  "gsm": { "registered": true, "signalPercent": 76, "network": "Example network" },
  "vibratorActive": false,
  "ledsActive": true,
  "electrodes": { "contactDetected": true }
}
```

Coordinates are decimal degrees, accelerometer values are in m/s², gyroscope values are in degrees/second, and percentage fields are from 0 to 100. All telemetry fields are optional; when present, fall and obstacle detections, GSM registration, and electrode contact are booleans, while vibrator and LED fields report whether their outputs are active. Send `obstacleDetected: true` when an obstacle is detected and `false` when the sensor clears; each transition from clear to detected creates a local dashboard notification. This notification does not send an SMS, use GSM, or contact anyone. The dashboard validates incoming data and shows connection or message errors in its connection panel. Sparse telemetry updates retain each component's latest reported reading until the Bluetooth connection ends; fields not yet reported remain marked as waiting or not reported. The Overview incident timeline is built from session alerts. The Hardware view displays ESP32, motion, obstacle, battery, GPS, and LED status reported by the device; it does not send control commands.

Bluetooth access requires a browser with Web Bluetooth support and a secure context (HTTPS or `localhost`). The repository contains the dashboard only, not ESP32 firmware; GPIO wiring, voltage levels, sensor drivers, fall thresholds, GSM network/SIM configuration, Bluetooth advertising, and local output behavior must be implemented and tested in firmware for the chosen modules.

## Google Maps preview (optional)

The location panel can show live coordinates from the connected ESP32 or, with permission, the browser device's location. A Google Maps view requires an API key.

To use browser location, open the **Location** tab and choose **Start live browser location**. The browser will ask for permission; this works on HTTPS or `localhost`. It reports the browser device's position, not the wearable's, and is cleared when tracking is stopped.

1. Copy `.env.example` to `.env`.
2. Set `VITE_GOOGLE_MAPS_API_KEY` in `.env` to a key with the Google Maps Embed API enabled.
3. Restart the Vite development server.

Restrict the key to the development/production websites and only the APIs you use. Vite variables prefixed with `VITE_` are included in the browser bundle; this key is not a secret.

Without a configured key, the dashboard shows live coordinates and accuracy without an embedded map. With a key, Google Maps centers on the latest available live coordinates (ESP32 GPS when connected, otherwise browser location).

## Prototype boundaries

- Without an ESP32 Bluetooth connection, hardware readings such as battery, motion, fall, and obstacle status are unavailable and are shown as waiting or not reported. Browser location can be started separately with user permission; it reports the browser device's location, not the ESP32's.
- The Overview incident timeline contains only session alerts; it does not calculate a safety score.
- Emergency contacts and SMS/call delivery are not configured. All dashboard notifications are local and are not sent to another person.
- Obstacle detections create local dashboard notifications only. They do not send SMS messages or contact caregivers.
- A live ESP32 connection displays hardware telemetry, but this prototype does not contact caregivers or emergency services.
- This prototype is not an emergency service and should not be relied on for personal safety.
- A visual dashboard alone is not an accessible alert channel for a deafblind user; a production system needs user-tested accessible/tactile notifications and appropriate caregiver workflows.
