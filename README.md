# VORTEX HQ — Dual-Market Research + Push Alerts

Expo / React Native Android app with a separate Node cloud scanner. MEXC Spot and MEXC USDT Perpetual Futures are independent workspaces with separate market universes, data endpoints, analysis rules, research inboxes and cached sessions. Research and paper-study only: no exchange login, order execution, leverage controls, or real-money trading.

## Two independent workspaces

### SPOT — holding research
- Uses MEXC Spot public ticker and candle endpoints (not futures candles).
- Daily and weekly holding-thesis model: trend health, CMF/volume flow, RSI health and price structure.
- Labels accumulation/holding-strength observations separately from distribution/thesis-risk warnings.
- No short-side Spot signals. A bearish reading is a thesis-risk observation, not a short instruction.
- Funding and open interest are intentionally omitted because they are derivatives-only data.

### FUTURES — short-horizon derivatives research
- Uses MEXC Contract public ticker and candle endpoints.
- 5m/15m/1h/4h/1d/1w context, trend alignment, volatility, funding, open interest, volume, VWAP, CMF and market structure.
- Bullish and bearish research observations are separately labelled.
- Funding and open interest are displayed only when returned by MEXC. Missing fields are not invented.

## Shared intelligence
- Macro Radar: public global market-cap and BTC/ETH dominance context plus Fear & Greed sentiment feed, with explicit unavailable states if a provider is down or rate-limits requests.
- Market Radar, Research Inbox, asset analysis, watchlist, derivatives context, journal and Command Centre.
- Mode-specific local data caches so switching Spot/Futures does not blend their research histories.
- Deduplicated cloud notifications carry `marketMode: SPOT` or `marketMode: FUTURES` so the app can open the correct workspace.

## Advanced research engine
- Completed-candle calculations: EMA 9/21/50/200, RSI, MACD, ATR, ADX/+DI/-DI, VWAP, volume expansion, CMF and pivot-based structure.
- Regime classification: trending, ranging, transition, high volatility and extreme volatility.
- Weighted evidence scoring with A/B/C/watch quality grades, directional bias, conflict flags and historical structure references.
- Multi-timeframe agreement checks. Spot has a separate daily/weekly holding-thesis model; Futures uses short-horizon derivatives analysis.
- A score is a rule-confluence measure, not a probability, win rate, forecast accuracy or return estimate.

## Android push notifications

The app requests notification permission, creates the Android `vortex-signals` channel, obtains an Expo push token on a physical device, and registers it with the cloud scanner when `EXPO_PUBLIC_VORTEX_API_URL` is configured. The cloud service independently scans both MEXC universes and sends separate Spot/Futures notifications. Android can display them while another app is in the foreground or the phone is locked, subject to notification permission, connectivity, Android battery policies and push-provider delivery.

**Important:** push alerts are not active merely because the app source contains the feature. You must deploy the cloud scanner, configure the app's cloud URL and EAS project ID, build/install the Android app, grant notification permission, and confirm `/health` reports registered devices and both market universes.

## Run the app

```bash
npm install
npx expo start
```

For a real Android push token, use a physical Android device and an EAS development/preview build. Configure EAS:

```bash
npm install -g eas-cli
eas login
eas build:configure
```

Set the EAS project ID in `app.json` at `expo.extra.eas.projectId`, then set the cloud URL in the Expo build environment or `.env`:

```bash
EXPO_PUBLIC_VORTEX_API_URL=https://YOUR-DEPLOYED-SCANNER-URL
```

Rebuild the Android app after configuring the URL and project ID.

## Run/deploy the cloud scanner

```bash
cd server
npm start
```

The service exposes `GET /health`, `POST /register`, and a protected `POST /admin/scan` (requires `VORTEX_ADMIN_KEY`). It rotates through both Spot and Futures universes. The server needs Node.js 20+ and outbound access to MEXC and Expo push services. Deploy the `server` directory to a host that supports long-running Node processes.

Free hosting may sleep, restart, throttle requests or lack persistent storage. A sleeping service cannot continuously scan or deliver alerts. This is a genuine infrastructure constraint, not something the APK can bypass. Check `/health` after deployment; it reports Spot/Futures symbol counts, device registrations, last scan and last error.

## Android APK

```bash
npm install -g eas-cli
eas login
eas build --platform android --profile preview
```

The `preview` profile creates an installable APK. Build and push delivery have not been run from this package; deployment and device testing remain required.

## Data and research limitations

- MEXC public endpoints can change, throttle or become unavailable.
- The phone scanner rotates through a small batch; it does not analyse every market simultaneously.
- The cloud scanner rotates through both universes. Full-universe coverage time depends on market count, provider limits and host uptime.
- Fear & Greed and global-market metrics come from separate public providers and can be delayed or unavailable.
- Research observations can become stale; they are not trade instructions or guaranteed predictions.
