import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyseCandles, analyseSpotCandles, combineTimeframes } from "./signalEngine";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import {
  ActivityIndicator, RefreshControl, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TextInput, TouchableOpacity, View
} from "react-native";

// VORTEX HQ — public-market-data research terminal. No order execution.
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }) });

const FUTURES_API = "https://contract.mexc.com/api/v1/contract";
const SPOT_API = "https://api.mexc.com/api/v3";
const FRAMES = [
  { key: "5m", api: "Min5" }, { key: "15m", api: "Min15" },
  { key: "1h", api: "Min60" }, { key: "4h", api: "Hour4" }, { key: "1d", api: "Day1" }, { key: "1w", api: "Week1"}
];
const BATCH_SIZE = 3;
const SCAN_INTERVAL = 15000;
const REQUEST_GAP = 650;
const C = {
  bg: "#070B13", panel: "#101827", panel2: "#142033", line: "#26364D",
  green: "#38D6A2", red: "#FF647C", blue: "#76B7FF", yellow: "#F5C65B",
  purple: "#B69CFF", white: "#F3F6FC", muted: "#8998AD", dim: "#617187"
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const fmt = (v, d = 2) => Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: d });
const pct = v => `${v >= 0 ? "+" : ""}${fmt(v)}%`;
const coinName = s => String(s || "").replace("_USDT", "");
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1); let prev = values[0];
  return values.map((v, i) => { if (i) prev = v * k + prev * (1 - k); return prev; });
}
function sma(values, period) {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    const a = values.slice(i + 1 - period, i + 1);
    return a.reduce((x, y) => x + y, 0) / period;
  });
}
function rsiCalc(values, period = 14) {
  const out = Array(values.length).fill(null); if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0); }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]; ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function parseKlines(data) {
  if (Array.isArray(data) && Array.isArray(data[0])) return data.map(x => ({ time: n(x[0]) / 1000, open: n(x[1]), high: n(x[2]), low: n(x[3]), close: n(x[4]), volume: n(x[5]) })).filter(x => x.time > 0 && x.close > 0);
  if (!data || !Array.isArray(data.time) || !Array.isArray(data.open) || !Array.isArray(data.close) || !Array.isArray(data.high) || !Array.isArray(data.low) || !Array.isArray(data.vol)) return [];
  return data.time.map((time, i) => ({ time: n(time), open: n(data.open[i]), high: n(data.high[i]), low: n(data.low[i]), close: n(data.close[i]), volume: n(data.vol[i]) }))
    .filter(x => x.time > 0 && x.open > 0 && x.high > 0 && x.low > 0 && x.close > 0);
}
function buildAnalysis(raw) {
  if (!raw || raw.length < 90) return { ready: false, message: "Waiting for 90+ candles", count: raw ? raw.length : 0 };
  // The newest candle can still be forming; all classifications use completed candles only.
  const cs = raw.slice(0, -1), close = cs.map(x => x.close), high = cs.map(x => x.high), low = cs.map(x => x.low), vol = cs.map(x => x.volume);
  const e9 = ema(close, 9), e21 = ema(close, 21), e50 = ema(close, 50), e200 = ema(close, 200);
  const rsi = rsiCalc(close), fast = ema(close, 12), slow = ema(close, 26), macd = fast.map((x, i) => x - slow[i]), macdSig = ema(macd, 9);
  const tr = cs.map((x, i) => i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - close[i - 1]), Math.abs(x.low - close[i - 1])));
  const atr = ema(tr, 14), plusDM = [], minusDM = [];
  for (let i = 0; i < cs.length; i++) {
    const up = i ? high[i] - high[i - 1] : 0, down = i ? low[i - 1] - low[i] : 0;
    plusDM.push(up > down && up > 0 ? up : 0); minusDM.push(down > up && down > 0 ? down : 0);
  }
  const pdi = ema(plusDM, 14).map((x, i) => atr[i] ? 100 * x / atr[i] : 0);
  const mdi = ema(minusDM, 14).map((x, i) => atr[i] ? 100 * x / atr[i] : 0);
  const dx = pdi.map((x, i) => x + mdi[i] ? 100 * Math.abs(x - mdi[i]) / (x + mdi[i]) : 0);
  const adx = ema(dx, 14);
  const mid = sma(close, 20), variance = close.map((_, i) => {
    if (i < 19) return null; const a = close.slice(i - 19, i + 1), m = mid[i];
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / 20);
  });
  const i = cs.length - 1, last = cs[i], prev = cs[i - 1], price = last.close;
  const avgVol = vol.slice(Math.max(0, i - 20), i).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, i));
  const volRatio = avgVol ? last.volume / avgVol : 0;
  const typical = cs.slice(Math.max(0, i - 49), i + 1);
  const totalV = typical.reduce((a, x) => a + x.volume, 0);
  const vwap = totalV ? typical.reduce((a, x) => a + ((x.high + x.low + x.close) / 3) * x.volume, 0) / totalV : price;
  let obv = 0; for (let j = Math.max(1, i - 20); j <= i; j++) obv += close[j] > close[j - 1] ? vol[j] : close[j] < close[j - 1] ? -vol[j] : 0;
  const flowWindow = cs.slice(Math.max(0, i - 19), i + 1);
  const mfv = flowWindow.reduce((a, x) => a + (x.high !== x.low ? ((2 * x.close - x.high - x.low) / (x.high - x.low)) * x.volume : 0), 0);
  const mfmVol = flowWindow.reduce((a, x) => a + x.volume, 0);
  const cmf = mfmVol ? mfv / mfmVol : 0;
  const atrPct = price ? atr[i] / price * 100 : 0;
  const upper = mid[i] == null ? null : mid[i] + 2 * variance[i];
  const lower = mid[i] == null ? null : mid[i] - 2 * variance[i];
  const bullTrend = e9[i] > e21[i] && e21[i] > e50[i] && price > e50[i];
  const bearTrend = e9[i] < e21[i] && e21[i] < e50[i] && price < e50[i];
  const trend = bullTrend ? "BULLISH" : bearTrend ? "BEARISH" : "MIXED";
  const adxValue = adx[i];
  const regime = atrPct > 2.5 ? "HIGH VOLATILITY" : adxValue >= 23 ? "TRENDING" : adxValue < 16 ? "RANGING" : "TRANSITION";
  const recentHigh = Math.max(...high.slice(Math.max(0, i - 19), i));
  const recentLow = Math.min(...low.slice(Math.max(0, i - 19), i));
  const swingHighs = [], swingLows = [];
  for (let j = Math.max(2, i - 45); j < i - 2; j++) {
    if (high[j] > high[j - 1] && high[j] > high[j - 2] && high[j] >= high[j + 1] && high[j] >= high[j + 2]) swingHighs.push(high[j]);
    if (low[j] < low[j - 1] && low[j] < low[j - 2] && low[j] <= low[j + 1] && low[j] <= low[j + 2]) swingLows.push(low[j]);
  }
  const resistance = swingHighs.length ? Math.max(...swingHighs.slice(-5)) : recentHigh;
  const support = swingLows.length ? Math.min(...swingLows.slice(-5)) : recentLow;
  const breakoutUp = price > recentHigh && volRatio > 1.25;
  const breakoutDown = price < recentLow && volRatio > 1.25;
  const falseUp = last.high > recentHigh && price < recentHigh;
  const falseDown = last.low < recentLow && price > recentLow;
  const checksBull = [bullTrend, price > e9[i], rsi[i] >= 50 && rsi[i] <= 70, macd[i] > macdSig[i], price > vwap, volRatio >= 1.15, pdi[i] > mdi[i], cmf > 0];
  const checksBear = [bearTrend, price < e9[i], rsi[i] <= 50 && rsi[i] >= 30, macd[i] < macdSig[i], price < vwap, volRatio >= 1.15, mdi[i] > pdi[i], cmf < 0];
  const bullScore = checksBull.filter(Boolean).length, bearScore = checksBear.filter(Boolean).length;
  const score = Math.max(bullScore, bearScore), direction = bullScore > bearScore ? "BULLISH" : bearScore > bullScore ? "BEARISH" : "NEUTRAL";
  const isRange = regime === "RANGING";
  const event = !isRange && score >= 6 && direction !== "NEUTRAL" ? "HIGH CONFLUENCE" : breakoutUp ? "UPSIDE BREAKOUT WATCH" : breakoutDown ? "DOWNSIDE BREAKOUT WATCH" : falseUp ? "POSSIBLE FAILED UPSIDE BREAK" : falseDown ? "POSSIBLE FAILED DOWNSIDE BREAK" : null;
  const confidenceLabel = score >= 7 ? "STRONG CONFLUENCE" : score >= 6 ? "GOOD CONFLUENCE" : score >= 4 ? "PARTIAL ALIGNMENT" : "LOW ALIGNMENT";
  return {
    ready: true, time: last.time, price, count: cs.length, trend, regime, direction, score,
    confidenceLabel, event, bullScore, bearScore, ema9: e9[i], ema21: e21[i], ema50: e50[i], ema200: e200[i],
    rsi: rsi[i], macd: macd[i], macdSignal: macdSig[i], adx: adxValue, plusDI: pdi[i], minusDI: mdi[i],
    atrPercent: atrPct, volumeRatio: volRatio, vwap, obv, cmf, bbUpper: upper, bbMid: mid[i], bbLower: lower,
    support, resistance, breakoutUp, breakoutDown, falseUp, falseDown,
    evidence: [
      bullTrend ? "EMA 9/21/50 bullish stack" : bearTrend ? "EMA 9/21/50 bearish stack" : "EMA trend stack mixed",
      price > vwap ? "Price above rolling VWAP" : "Price below rolling VWAP",
      macd[i] > macdSig[i] ? "MACD momentum positive" : "MACD momentum negative",
      `RSI ${fmt(rsi[i])}`, `ADX ${fmt(adxValue)} (${regime.toLowerCase()})`,
      `Volume ${fmt(volRatio)}x 20-candle average`, `CMF ${fmt(cmf, 3)}`,
      breakoutUp ? "Close broke recent range high" : breakoutDown ? "Close broke recent range low" : "No confirmed 20-candle range break"
    ]
  };
}

export default function App() {
  const [tab, setTab] = useState("HOME");
  const [marketMode, setMarketMode] = useState("FUTURES");
  const modeStoreRef = useRef({});
  const API = marketMode === "SPOT" ? SPOT_API : FUTURES_API;
  const [markets, setMarkets] = useState([]);
  const [research, setResearch] = useState({});
  const [signals, setSignals] = useState([]);
  const [watch, setWatch] = useState(["BTC_USDT", "ETH_USDT", "SOL_USDT"]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("TURNOVER");
  const [frame, setFrame] = useState("1h");
  const [selected, setSelected] = useState("BTC_USDT");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState("CONNECTING");
  const [marketTime, setMarketTime] = useState("");
  const [scanTime, setScanTime] = useState("");
  const [scanCount, setScanCount] = useState(0);
  const [scanFail, setScanFail] = useState(0);
  const [journal, setJournal] = useState([]);
  const [journalText, setJournalText] = useState("");
  const [expanded, setExpanded] = useState("");
  const [macro, setMacro] = useState({ loading: true, fearGreed: null, btcDominance: null, totalMarketCap: null, marketCapChange: null, updated: null, error: null });
  const marketsRef = useRef([]), cursorRef = useRef(0), busyRef = useRef(false), seenRef = useRef({}), analysisRef = useRef({}), mounted = useRef(true), modeGenerationRef = useRef(0), currentModeRef = useRef(marketMode);
  currentModeRef.current = marketMode;

  const loadMarkets = useCallback(async () => {
    const generation = modeGenerationRef.current;
    try {
      const res = await fetch(marketMode === "SPOT" ? `${SPOT_API}/ticker/24hr` : `${FUTURES_API}/ticker`);
      if (!res.ok) throw new Error(`Ticker HTTP ${res.status}`);
      const json = await res.json();
      const raw = marketMode === "SPOT" ? (Array.isArray(json) ? json : []) : (Array.isArray(json.data) ? json.data : []);
      if (!raw.length) throw new Error("Unexpected MEXC ticker response");
      const rows = raw.map(x => marketMode === "SPOT" ? ({
        symbol: String(x.symbol || "").replace(/USDT$/, "_USDT"), price: n(x.lastPrice),
        change: n(x.priceChangePercent), turnover: n(x.quoteVolume), volume: n(x.volume), oi: 0, funding: 0
      }) : ({ symbol: x.symbol, price: n(x.lastPrice), change: n(x.riseFallRate) * 100,
        turnover: n(x.amount24), volume: n(x.volume24), oi: n(x.holdVol), funding: n(x.fundingRate) * 100 }))
        .filter(x => x.symbol.endsWith("_USDT") && x.price > 0);
      if (mounted.current && generation === modeGenerationRef.current) { marketsRef.current = rows; setMarkets(rows); setMarketTime(new Date().toLocaleTimeString()); setConnection("LIVE DATA"); }
    } catch (e) { if (mounted.current && generation === modeGenerationRef.current) setConnection(`OFFLINE · ${e.message}`); }
    finally { if (mounted.current && generation === modeGenerationRef.current) setLoading(false); }
  }, [marketMode]);

  const scanBatch = useCallback(async () => {
    const generation = modeGenerationRef.current;
    if (busyRef.current || !marketsRef.current.length) return;
    busyRef.current = true; if (mounted.current) setBusy(true);
    let ok = 0, failed = 0;
    try {
      const universe = marketsRef.current;
      const batch = [];
      for (let i = 0; i < Math.min(BATCH_SIZE, universe.length); i++) batch.push(universe[(cursorRef.current + i) % universe.length]);
      cursorRef.current = (cursorRef.current + batch.length) % universe.length;
      for (const market of batch) {
        if (generation !== modeGenerationRef.current) return;
        for (const tf of FRAMES) {
          if (generation !== modeGenerationRef.current) return;
          try {
            const apiSymbol = marketMode === "SPOT" ? market.symbol.replace("_", "") : market.symbol;
            const url = marketMode === "SPOT" ? `${SPOT_API}/klines?symbol=${apiSymbol}&interval=${({"5m":"5m","15m":"15m","1h":"60m","4h":"4h","1d":"1d","1w":"1W"})[tf.key]}&limit=240` : `${FUTURES_API}/kline/${encodeURIComponent(market.symbol)}?interval=${tf.api}&limit=240`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json(); const candles = parseKlines(marketMode === "SPOT" ? json : json.data);
            const basic = buildAnalysis(candles);
            const advanced = marketMode === "SPOT" ? analyseSpotCandles(candles, tf.key) : analyseCandles(candles, tf.key);
            const cachedFrames = { ...(analysisRef.current[market.symbol] || {}), [tf.key]: advanced };
            analysisRef.current[market.symbol] = cachedFrames;
            const mtf = combineTimeframes(cachedFrames);
            const spotHigher = cachedFrames["1d"]?.qualified && cachedFrames["1w"]?.qualified;
            const spotBull = advanced.qualified && (tf.key === "1d" || tf.key === "1w") && spotHigher;
            const spotBear = advanced.distributionRisk && (tf.key === "1d" || tf.key === "1w");
            const modeEvent = marketMode === "SPOT" ? (spotBull ? "ACCUMULATION / HOLDING-STRENGTH WATCH" : spotBear ? "DISTRIBUTION / THESIS RISK" : null) : (advanced.qualified && mtf.qualified ? advanced.side : null);
            const result = { ...basic, ...advanced, mtf, marketMode, count: advanced.ready ? candles.length - 1 : candles.length, event: modeEvent, confidenceLabel: advanced.ready ? `${marketMode} · GRADE ${advanced.quality} · ${advanced.score}/100 · MTF ${mtf.alignment || 0}%` : basic.confidenceLabel, scannedAt: new Date().toLocaleTimeString(), holdingContext: marketMode === "SPOT" ? "Daily/weekly holding thesis context; downside readings are risk/distribution warnings, never short-side instructions." : "Short-horizon derivatives context; funding and open interest are futures-only fields." }; ok++;
            if (!mounted.current || generation !== modeGenerationRef.current) return;
            setResearch(old => { const frames = { ...(old[market.symbol] || {}), [tf.key]: result }; const mtf = combineTimeframes(frames); return { ...old, [market.symbol]: { ...frames, _mtf: mtf } }; });
            if (result.ready && result.event) {
              const id = `${marketMode}|${market.symbol}|${tf.key}|${result.time}|${result.event}`;
              if (!seenRef.current[id]) {
                seenRef.current[id] = true;
                const item = { id, symbol: market.symbol, timeframe: tf.key, marketMode, ...result, created: new Date().toLocaleString() };
                setSignals(old => [item, ...old].slice(0, 250));
              }
            }
          } catch (e) { failed++; }
          await wait(REQUEST_GAP);
        }
      }
      if (mounted.current) { setScanCount(x => x + ok); setScanFail(x => x + failed); setScanTime(new Date().toLocaleTimeString()); }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }, [marketMode]);

  useEffect(() => {
    let active = true;
    const registerPush = async () => {
      try {
        if (!Device.isDevice) return;
        const current = await Notifications.getPermissionsAsync();
        let status = current.status;
        if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
        if (status !== "granted" || !active) return;
        if (Device.osName === "Android") await Notifications.setNotificationChannelAsync("vortex-signals", { name: "VORTEX Research Alerts", importance: Notifications.AndroidImportance.MAX, vibrationPattern: [0, 250, 150, 250], lightColor: "#38D6A2" });
        const projectId = Constants.easConfig?.projectId || Constants.expoConfig?.extra?.eas?.projectId;
        const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : {})).data;
        const cloudUrl = process.env.EXPO_PUBLIC_VORTEX_API_URL;
        if (cloudUrl) await fetch(`${cloudUrl.replace(/\/$/, "")}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      } catch (e) { console.log("VORTEX push registration:", e.message); }
    };
    registerPush();
    const sub = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data || {};
      if (data.symbol) { if (data.marketMode && data.marketMode !== currentModeRef.current) { modeGenerationRef.current += 1; currentModeRef.current = data.marketMode; setMarketMode(data.marketMode); setMarkets([]); marketsRef.current = []; setResearch({}); setSignals([]); setWatch(["BTC_USDT", "ETH_USDT", "SOL_USDT"]); setScanCount(0); setScanFail(0); setScanTime(""); setLoading(true); setConnection("CONNECTING"); analysisRef.current = {}; seenRef.current = {}; cursorRef.current = 0; } setSelected(data.symbol); setFrame(data.timeframe || (data.marketMode === "SPOT" ? "1d" : "15m")); setTab("ASSET"); }
      else setTab("SIGNALS");
    });
    return () => { active = false; sub.remove(); };
  }, []);

  useEffect(() => {
    mounted.current = true; loadMarkets();
    const tickerTimer = setInterval(loadMarkets, 45000);
    const scanTimer = setInterval(scanBatch, SCAN_INTERVAL);
    return () => { mounted.current = false; clearInterval(tickerTimer); clearInterval(scanTimer); };
  }, [loadMarkets, scanBatch]);
  useEffect(() => {
    let alive = true;
    const loadMacro = async () => {
      try {
        const [globalRes, fearRes] = await Promise.all([
          fetch("https://api.coingecko.com/api/v3/global"),
          fetch("https://api.alternative.me/fng/?limit=1")
        ]);
        if (!globalRes.ok || !fearRes.ok) throw new Error("One or more public macro feeds are unavailable");
        const [globalJson, fearJson] = await Promise.all([globalRes.json(), fearRes.json()]);
        const g = globalJson.data || {}, f = fearJson.data?.[0] || {};
        if (alive) setMacro({ loading: false, fearGreed: f.value != null ? Number(f.value) : null, fearLabel: f.value_classification || "Unavailable", btcDominance: g.market_cap_percentage?.btc ?? null, ethDominance: g.market_cap_percentage?.eth ?? null, totalMarketCap: g.total_market_cap?.usd ?? null, marketCapChange: g.market_cap_change_percentage_24h_usd ?? null, updated: new Date().toLocaleTimeString(), error: null });
      } catch (e) { if (alive) setMacro(old => ({ ...old, loading: false, error: e.message })); }
    };
    loadMacro(); const timer = setInterval(loadMacro, 300000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => { if (markets.length && scanCount === 0) scanBatch(); }, [markets.length]);

  const sorted = useMemo(() => [...markets].sort((a, b) => sort === "MOVEMENT" ? Math.abs(b.change) - Math.abs(a.change) : sort === "OI" ? b.oi - a.oi : sort === "FUNDING" ? Math.abs(b.funding) - Math.abs(a.funding) : b.turnover - a.turnover), [markets, sort]);
  const filtered = useMemo(() => sorted.filter(x => x.symbol.toLowerCase().includes(query.toLowerCase().replace("/", "_"))), [sorted, query]);
  const btc = markets.find(x => x.symbol === "BTC_USDT");
  const eth = markets.find(x => x.symbol === "ETH_USDT");
  const breadth = markets.length ? markets.filter(x => x.change > 0).length / markets.length * 100 : 0;
  const avgMove = markets.length ? markets.reduce((a, x) => a + x.change, 0) / markets.length : 0;
  const watched = sorted.filter(x => watch.includes(x.symbol));
  const selectedData = research[selected] && research[selected][frame];
  const readyResearch = Object.values(research).flatMap(x => Object.entries(x).filter(([k]) => k !== "_mtf").map(([, v]) => v)).filter(x => x && x.ready);
  const regimeCounts = readyResearch.reduce((a, x) => { a[x.regime] = (a[x.regime] || 0) + 1; return a; }, {});
  const highConfluence = signals.filter(x => x.quality === "A");
  const toggleWatch = symbol => setWatch(old => old.includes(symbol) ? old.filter(x => x !== symbol) : [...old, symbol]);
  const manualRefresh = async () => { await loadMarkets(); await scanBatch(); };
  const addJournal = () => { if (journalText.trim()) { setJournal(old => [{ text: journalText.trim(), time: new Date().toLocaleString() }, ...old]); setJournalText(""); } };

  const Card = ({ children, style }) => <View style={[s.card, style]}>{children}</View>;
  const Heading = ({ children, right }) => <View style={s.headingRow}><Text style={s.heading}>{children}</Text>{right ? <Text style={s.muted}>{right}</Text> : null}</View>;
  const Metric = ({ label, value, color }) => <View style={s.metric}><Text style={s.metricLabel}>{label}</Text><Text numberOfLines={1} style={[s.metricValue, color ? { color } : null]}>{value}</Text></View>;
  const Pill = ({ label, active, onPress }) => <TouchableOpacity onPress={onPress} style={[s.pill, active && s.pillActive]}><Text style={[s.pillText, active && { color: C.green }]}>{label}</Text></TouchableOpacity>;
  const Header = ({ title, subtitle }) => <View style={s.header}><View style={s.brandRow}><Text style={s.brand}>VORTEX <Text style={{ color: C.green }}>HQ</Text></Text><View style={s.liveDot}><View style={[s.dot, { backgroundColor: connection === "LIVE DATA" ? C.green : C.yellow }]} /><Text style={s.liveText}>{connection}</Text></View></View><Text style={s.pageTitle}>{title}</Text><Text style={s.subtitle}>{subtitle}</Text><Text style={s.meta}>{markets.length.toLocaleString()} MEXC USDT {marketMode} MARKETS  ·  TICKER {marketTime || "WAITING"}</Text></View>;
  const Search = () => <TextInput value={query} onChangeText={setQuery} style={s.search} placeholder="Search any contract..." placeholderTextColor={C.dim} autoCapitalize="characters" />;
  const CoinRow = ({ item }) => <TouchableOpacity activeOpacity={0.8} onPress={() => { setSelected(item.symbol); setTab("ASSET"); }} style={s.coinRow}><View style={{ flex: 1 }}><Text style={s.coinName}>{coinName(item.symbol)}</Text><Text style={s.mini}>{marketMode === "SPOT" ? "SPOT · 24H QUOTE VOLUME" : "USDT PERPETUAL · 24H TURNOVER"} ${fmt(item.turnover, 0)}</Text></View><View style={{ alignItems: "flex-end" }}><Text style={s.coinPrice}>${fmt(item.price, 8)}</Text><Text style={{ color: item.change >= 0 ? C.green : C.red, fontWeight: "800", fontSize: 12 }}>{pct(item.change)}</Text></View><TouchableOpacity onPress={() => toggleWatch(item.symbol)} style={s.star}><Text style={{ color: watch.includes(item.symbol) ? C.yellow : C.dim, fontSize: 20 }}>{watch.includes(item.symbol) ? "★" : "☆"}</Text></TouchableOpacity></TouchableOpacity>;
  const MarketList = ({ items, limit = 100 }) => <>{items.slice(0, limit).map(x => <CoinRow key={x.symbol} item={x} />)}{!items.length && <Card><Text style={s.muted}>No matching markets yet. Check connection or search term.</Text></Card>}</>;
  const ResearchPanel = ({ data }) => {
    if (!data || !data.ready) return <Card><Text style={s.muted}>{data ? data.message : "No research data for this pair/timeframe yet. The rotating scanner will reach it."}</Text></Card>;
    const dc = data.direction === "LONG_BIAS" ? C.green : data.direction === "SHORT_BIAS" ? C.red : C.yellow;
    return <>
      <Card><View style={s.split}><View><Text style={s.kicker}>COMPLETED-CANDLE STUDY</Text><Text style={s.bigPrice}>${fmt(data.price, 8)}</Text></View><Text style={[s.direction, { color: dc }]}>{data.marketMode === "SPOT" ? (data.displayDirection || data.phase) : data.direction}</Text></View><Text style={s.muted}>{data.marketMode === "SPOT" ? `${data.phase || "HOLDING THESIS"} · ${data.holdingHorizon || "LONG HORIZON"} · THESIS ${data.thesisScore ?? "—"}/4 · ` : "FUTURES SETUP · "}{data.regime} · {data.confidenceLabel} · {data.score}/100 research score · scanned {data.scannedAt || "time unavailable"}</Text>
        <View style={s.metricsGrid}><Metric label="RSI 14" value={fmt(data.rsi)} /><Metric label="ADX 14" value={fmt(data.adx)} /><Metric label="ATR %" value={pct(data.atrPercent)} /><Metric label="VOL / AVG" value={`${fmt(data.volumeRatio)}x`} /><Metric label="EMA 9" value={fmt(data.ema9, 6)} /><Metric label="EMA 21" value={fmt(data.ema21, 6)} /><Metric label="EMA 50" value={fmt(data.ema50, 6)} /><Metric label="EMA 200" value={fmt(data.ema200, 6)} /><Metric label="VWAP" value={fmt(data.vwap, 6)} /><Metric label="CMF 20" value={fmt(data.cmf, 3)} /><Metric label="+DI / -DI" value={`${fmt(data.plusDI)} / ${fmt(data.minusDI)}`} /><Metric label="CANDLES" value={data.count} /></View>
      </Card>
      <Card><Heading right="MARKET STRUCTURE">STRUCTURE & LEVELS</Heading><View style={s.metricsGrid}><Metric label="NEAR SUPPORT" value={fmt(data.support, 8)} color={C.green} /><Metric label="NEAR RESISTANCE" value={fmt(data.resistance, 8)} color={C.red} /><Metric label="BB UPPER" value={fmt(data.bbUpper, 8)} /><Metric label="BB MID" value={fmt(data.bbMid, 8)} /><Metric label="BB LOWER" value={fmt(data.bbLower, 8)} /><Metric label="OBV FLOW" value={fmt(data.obv, 0)} /></View><Text style={s.muted}>{data.breakoutUp ? "Range-high close breakout with volume expansion." : data.breakoutDown ? "Range-low close breakdown with volume expansion." : data.falseUp ? "Potential failed upside break / rejection." : data.falseDown ? "Potential failed downside break / recovery." : "No confirmed 20-candle range breakout in this snapshot."}</Text></Card>
      <Card><Heading right="WHY THE MODEL LEANED THIS WAY">EVIDENCE LOG</Heading>{data.evidence.map((x, i) => <View key={i} style={s.evidenceRow}><Text style={s.evidenceIndex}>{String(i + 1).padStart(2, "0")}</Text><Text style={s.evidenceText}>{x}</Text></View>)}<Text style={s.footnote}>{data.marketMode === "SPOT" ? "Spot thesis is a research horizon, not a recommendation to buy or hold. Downside readings flag thesis risk; no short-side spot action is implied." : "Futures research is educational only. No leverage, order execution or guaranteed outcome. Research score is not a probability or forecast accuracy."}</Text></Card>
    </>;
  };
  const SignalCard = ({ item }) => { const open = expanded === item.id; const color = item.direction === "LONG_BIAS" ? C.green : item.direction === "SHORT_BIAS" ? C.red : C.yellow; return <TouchableOpacity activeOpacity={0.9} onPress={() => setExpanded(open ? "" : item.id)} style={s.signalCard}><View style={s.split}><Text style={[s.signalDir, { color }]}>{item.event}</Text><Text style={s.signalTf}>{item.timeframe}</Text></View><Text style={s.signalCoin}>{coinName(item.symbol)}</Text><Text style={s.muted}>{item.created} · {item.regime} · score {item.score}/100</Text><Text style={s.signalDesc}>{item.marketMode || marketMode} · {item.confidenceLabel} — informational market observation, not a trade instruction.</Text>{open ? <View style={s.expanded}><Text style={s.kicker}>EVIDENCE</Text>{item.evidence.map((x, i) => <Text key={i} style={s.muted}>• {x}</Text>)}<Text style={s.muted}>Multi-timeframe: {item.mtf?.summary || "Confirmation not yet available"}</Text><Text style={s.muted}>Observed reference price: ${fmt(item.price, 8)}</Text><Text style={s.muted}>Structure: support ${fmt(item.support, 8)} · resistance ${fmt(item.resistance, 8)}</Text><Text style={s.footnote}>Based on the latest completed candle available at scan time. It may become stale as markets change.</Text></View> : <Text style={s.tap}>TAP TO EXPAND EVIDENCE</Text>}</TouchableOpacity>; };

  const tabs = ["HOME", "RADAR", "BTC", "ALTS", "MACRO", "SIGNALS", "ASSET", "WATCH", "FAVOURITES", "DERIVS", "JOURNAL"];
  const titles = { HOME: ["Command Centre", "Global market state, scanner health and research activity."], RADAR: ["Market Radar", marketMode === "SPOT" ? "All discovered MEXC USDT spot pairs." : "All discovered MEXC USDT perpetual contracts."], BTC: ["Bitcoin Research", "BTC multi-timeframe analysis in the selected market workspace."], ALTS: ["Altcoin Radar", "Altcoin market universe and rotating asset research."], MACRO: ["Macro Radar", "Global market capitalization, dominance and sentiment context."], SIGNALS: ["Research Inbox", "Deduplicated, explainable market observations."], ASSET: [coinName(selected), "Multi-timeframe technical and market-structure research."], WATCH: ["Watchlist", "Your locally selected research universe."], FAVOURITES: ["Favourites", "Your starred markets, kept separate between Spot and Futures."], DERIVS: ["Derivatives Context", marketMode === "SPOT" ? "Spot market flow context; derivatives-only metrics are intentionally unavailable." : "Ticker-reported funding and open-interest snapshots."], JOURNAL: ["Research Journal", "Session notes for your own market-study process."] };
  const [pageTitle, pageSubtitle] = titles[tab] || titles.HOME;

  const renderHome = () => <>
    <View style={s.hero}><Text style={s.kicker}>{marketMode} MARKET INTELLIGENCE</Text><Text style={s.heroTitle}>The market, in context.</Text><Text style={s.heroSub}>{marketMode === "SPOT" ? "Spot accumulation/distribution · daily/weekly holding thesis · volume and relative strength" : "Perpetual derivatives · short-term direction · funding, open interest and multi-timeframe structure"}</Text><View style={s.heroActions}><TouchableOpacity style={s.primaryBtn} onPress={manualRefresh}><Text style={s.primaryText}>{busy ? "SCANNING..." : "REFRESH RESEARCH"}</Text></TouchableOpacity><Text style={s.mini}>{loading ? "Loading ticker" : `${scanCount} candle studies · ${scanFail} request errors`}</Text></View></View>
    <View style={s.metricsGrid}><Card style={s.statCard}><Metric label={marketMode === "SPOT" ? "SPOT PAIRS" : "PERPETUALS"} value={markets.length.toLocaleString()} /></Card><Card style={s.statCard}><Metric label="MARKET BREADTH" value={`${fmt(breadth)}% UP`} color={breadth >= 50 ? C.green : C.red} /></Card><Card style={s.statCard}><Metric label="AVG 24H MOVE" value={pct(avgMove)} color={avgMove >= 0 ? C.green : C.red} /></Card><Card style={s.statCard}><Metric label="OBSERVATIONS" value={signals.length} color={C.blue} /></Card></View>
    <Heading right={connection}>CORE MARKETS</Heading><Card>{[btc, eth].filter(Boolean).map(x => <CoinRow key={x.symbol} item={x} />)}{!btc && !eth ? <Text style={s.muted}>Waiting for BTC and ETH ticker records.</Text> : null}</Card>
    <Heading right={`${readyResearch.length} analysed frames`}>SCANNER INTELLIGENCE</Heading><Card><View style={s.metricsGrid}><Metric label="GRADE A SETUPS" value={highConfluence.length} color={C.green} /><Metric label="TRENDING FRAMES" value={regimeCounts.TRENDING || 0} /><Metric label="RANGING FRAMES" value={regimeCounts.RANGING || 0} /><Metric label="LAST SCAN" value={scanTime || "PENDING"} /></View><View style={s.progressTrack}><View style={[s.progressFill, { width: `${markets.length ? clamp(cursorRef.current / markets.length * 100, 2, 100) : 0}%` }]} /></View><Text style={s.footnote}>The free client rotates through the full contract list in small batches to limit API load. A ticker refresh does not mean every contract has just been rescanned.</Text></Card>
    <Heading right="LATEST">RECENT OBSERVATIONS</Heading>{signals.slice(0, 5).map(x => <SignalCard key={x.id} item={x} />)}{!signals.length && <Card><Text style={s.muted}>No qualifying observations yet. The scanner is building coverage.</Text></Card>}
    <Heading right="24H SNAPSHOT">LARGEST MOVERS</Heading><Card>{[...markets].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 6).map(x => <CoinRow key={x.symbol} item={x} />)}</Card>
  </>;
  const renderRadar = () => <><Search /><View style={s.pillRow}>{(marketMode === "SPOT" ? ["TURNOVER", "MOVEMENT"] : ["TURNOVER", "MOVEMENT", "OI", "FUNDING"]).map(x => <Pill key={x} label={x} active={sort === x} onPress={() => setSort(x)} />)}</View><Text style={s.mini}>{filtered.length} matching contracts · sorted by {sort.toLowerCase()}</Text><MarketList items={filtered} limit={200} /></>;
  const renderBTC = () => <>
    <Card><Text style={s.kicker}>BTC · {marketMode} WORKSPACE</Text><Text style={s.muted}>Bitcoin remains a major market-context reference. Each timeframe below uses the selected Spot or Futures data source.</Text></Card>
    {FRAMES.map(x => <TouchableOpacity key={x.key} activeOpacity={0.9} onPress={() => { setSelected("BTC_USDT"); setFrame(x.key); setTab("ASSET"); }}><Card><View style={s.split}><Text style={s.coinName}>BTC · {x.key.toUpperCase()}</Text><Text style={s.tap}>OPEN STUDY →</Text></View><Text style={s.muted}>{research.BTC_USDT?.[x.key]?.ready ? `${research.BTC_USDT[x.key].trend} · ${research.BTC_USDT[x.key].regime} · ${research.BTC_USDT[x.key].confidenceLabel}` : "Waiting for this timeframe's completed-candle scan"}</Text></Card></TouchableOpacity>)}
  </>;
  const renderAlts = () => <><Search /><Text style={s.mini}>{filtered.filter(x => x.symbol !== "BTC_USDT").length} altcoin pairs in the current {marketMode.toLowerCase()} universe.</Text><MarketList items={filtered.filter(x => x.symbol !== "BTC_USDT")} limit={120} /></>;
  const renderFavourites = () => <><Search /><MarketList items={sorted.filter(x => watch.includes(x.symbol) && x.symbol.toLowerCase().includes(query.toLowerCase().replace("/", "_")))} limit={200} /></>;

  const renderMacro = () => <>
    <Card><Text style={s.kicker}>GLOBAL CRYPTO CONTEXT</Text><Text style={s.muted}>Public global metrics and sentiment feeds. These are contextual indicators, not a forecast or a trade trigger.</Text><View style={s.metricsGrid}><Metric label="TOTAL MARKET CAP" value={macro.totalMarketCap == null ? "Unavailable" : `$${fmt(macro.totalMarketCap / 1e12, 3)}T`} /><Metric label="24H CAP CHANGE" value={macro.marketCapChange == null ? "—" : pct(macro.marketCapChange)} color={(macro.marketCapChange || 0) >= 0 ? C.green : C.red} /><Metric label="BTC DOMINANCE" value={macro.btcDominance == null ? "—" : `${fmt(macro.btcDominance)}%`} /><Metric label="ETH DOMINANCE" value={macro.ethDominance == null ? "—" : `${fmt(macro.ethDominance)}%`} /><Metric label="FEAR & GREED" value={macro.fearGreed == null ? "—" : `${macro.fearGreed}/100`} color={macro.fearGreed >= 55 ? C.green : macro.fearGreed <= 25 ? C.red : C.yellow} /><Metric label="SENTIMENT" value={macro.fearLabel || "—"} /></View><Text style={s.footnote}>{macro.loading ? "Loading public macro feeds…" : macro.error ? `Feed status: ${macro.error}` : `Updated ${macro.updated}. Feed values can be delayed or rate-limited.`}</Text></Card>
    <Card><Heading>MODE-SPECIFIC MACRO INTERPRETATION</Heading><Text style={s.muted}>{marketMode === "SPOT" ? "For Spot, use macro context to understand the broader holding environment: market-cap trend, BTC dominance, ETH participation and sentiment extremes. Confirm any thesis with daily and weekly asset-level structure." : "For Futures, macro context is a volatility and correlation filter. Sudden shifts in total market capitalization, BTC dominance or sentiment can destabilize otherwise aligned short-term setups. Wait for asset-level confirmation."}</Text></Card>
    <Card><Heading right="LOCAL MEXC UNIVERSE">MARKET BREADTH SNAPSHOT</Heading><View style={s.metricsGrid}><Metric label="PAIRS TRACKED" value={markets.length} /><Metric label="ADVANCING" value={`${fmt(breadth)}%`} color={breadth >= 50 ? C.green : C.red} /><Metric label="AVERAGE 24H MOVE" value={pct(avgMove)} color={avgMove >= 0 ? C.green : C.red} /></View><Text style={s.footnote}>Breadth is calculated from the currently loaded Spot or Futures universe, not the entire global crypto market.</Text></Card>
  </>;

  const renderSignals = () => <>{<View style={s.metricsGrid}><Card style={s.statCard}><Metric label="TOTAL" value={signals.length} /></Card><Card style={s.statCard}><Metric label="GRADE A SETUPS" value={highConfluence.length} color={C.green} /></Card></View>}{signals.slice(0, 150).map(x => <SignalCard key={x.id} item={x} />)}{!signals.length && <Card><Text style={s.muted}>No observations have qualified yet. This is normal; the system does not force a result.</Text></Card>}</>;
  const renderAsset = () => <><Search /><View style={s.assetResults}>{filtered.slice(0, 8).map(x => <TouchableOpacity key={x.symbol} onPress={() => setSelected(x.symbol)} style={s.assetResult}><Text style={s.coinName}>{coinName(x.symbol)}</Text><Text style={s.mini}>${fmt(x.price, 8)}</Text></TouchableOpacity>)}</View><View style={s.pillRow}>{FRAMES.map(x => <Pill key={x.key} label={x.key.toUpperCase()} active={frame === x.key} onPress={() => setFrame(x.key)} />)}</View><Text style={s.mini}>Selected {marketMode.toLowerCase()} market: {selected.replace("_", "/")} · tap a search result to open another asset.</Text><ResearchPanel data={selectedData} /><Heading>OTHER TIMEFRAMES</Heading>{FRAMES.filter(x => x.key !== frame).map(x => <TouchableOpacity key={x.key} onPress={() => setFrame(x.key)}><Card><View style={s.split}><Text style={s.coinName}>{x.key.toUpperCase()} STUDY</Text><Text style={s.tap}>OPEN →</Text></View><Text style={s.muted}>{research[selected] && research[selected][x.key] ? `${research[selected][x.key].trend} · ${research[selected][x.key].regime}` : "Awaiting rotating scan"}</Text></Card></TouchableOpacity>)}</>;
  const renderWatch = () => <>{watched.map(x => <CoinRow key={x.symbol} item={x} />)}{!watched.length && <Card><Text style={s.muted}>Your watchlist is empty. Add contracts with the star in Radar.</Text></Card>}<Heading>WATCHLIST RESEARCH</Heading>{watched.slice(0, 30).map(x => <TouchableOpacity key={x.symbol} onPress={() => { setSelected(x.symbol); setTab("ASSET"); }}><Card><Text style={s.coinName}>{coinName(x.symbol)}</Text><Text style={s.muted}>{research[x.symbol] && research[x.symbol][frame] ? `${research[x.symbol][frame].trend} · ${research[x.symbol][frame].regime}` : "Not scanned yet"}</Text></Card></TouchableOpacity>)}</>;
  const renderDerivs = () => marketMode === "SPOT" ? <Card><Text style={s.kicker}>SPOT DATA BOUNDARY</Text><Text style={s.muted}>Spot markets do not have perpetual funding rates or futures open interest. VORTEX keeps those metrics out of Spot analysis rather than displaying misleading zero values. Spot research focuses on holding thesis, accumulation/distribution, relative strength, volume flow and daily/weekly structure.</Text></Card> : <><Card><Text style={s.kicker}>DATA SOURCE NOTE</Text><Text style={s.muted}>Funding and open interest below are ticker snapshot fields where returned by MEXC. They are context only; no liquidation feed, long/short ratio or order-book depth is assumed to exist.</Text></Card><Search />{filtered.slice(0, 100).sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding)).map(x => <Card key={x.symbol}><View style={s.split}><Text style={s.coinName}>{coinName(x.symbol)}</Text><Text style={{ color: Math.abs(x.funding) >= 0.05 ? C.yellow : C.white }}>{pct(x.funding)} funding</Text></View><View style={s.metricsGrid}><Metric label="OPEN INTEREST" value={fmt(x.oi, 0)} /><Metric label="24H TURNOVER" value={`$${fmt(x.turnover, 0)}`} /><Metric label="24H CHANGE" value={pct(x.change)} color={x.change >= 0 ? C.green : C.red} /></View></Card>)}</>;
  const switchMarketMode = next => {
    if (next === marketMode) return;
    modeGenerationRef.current += 1;
    modeStoreRef.current[marketMode] = { markets, research, signals, watch, scanCount, scanFail, scanTime, marketTime };
    const saved = modeStoreRef.current[next];
    setMarketMode(next); setTab("HOME"); setQuery(""); setSelected("BTC_USDT"); setFrame(next === "SPOT" ? "1d" : "1h");
    if (saved) { setMarkets(saved.markets); marketsRef.current = saved.markets; setResearch(saved.research); setSignals(saved.signals); setWatch(saved.watch); setScanCount(saved.scanCount); setScanFail(saved.scanFail); setScanTime(saved.scanTime); setMarketTime(saved.marketTime); }
    else { setMarkets([]); marketsRef.current = []; setResearch({}); setSignals([]); setWatch(["BTC_USDT", "ETH_USDT", "SOL_USDT"]); setScanCount(0); setScanFail(0); setScanTime(""); setMarketTime(""); }
    cursorRef.current = 0; analysisRef.current = {}; seenRef.current = {}; setLoading(true); setConnection("CONNECTING");
  };

  const renderJournal = () => <><Card><Text style={s.kicker}>PERSONAL RESEARCH NOTE</Text><TextInput value={journalText} onChangeText={setJournalText} multiline placeholder="Record what you observed, what evidence mattered, and what you want to review..." placeholderTextColor={C.dim} style={[s.search, { minHeight: 100, textAlignVertical: "top" }]} /><TouchableOpacity onPress={addJournal} style={s.primaryBtn}><Text style={s.primaryText}>SAVE NOTE FOR THIS SESSION</Text></TouchableOpacity><Text style={s.footnote}>Notes currently stay in app memory and are cleared when the app session is reset.</Text></Card>{journal.map((x, i) => <Card key={i}><Text style={s.mini}>{x.time}</Text><Text style={s.body}>{x.text}</Text></Card>)}</>;

  return <SafeAreaView style={s.root}><StatusBar barStyle="light-content" backgroundColor={C.bg} /><View style={s.topbar}><Text style={s.brand}>VORTEX <Text style={{ color: C.green }}>HQ</Text></Text><Text style={s.topStatus}>{busy ? "● SCANNING" : "● RESEARCH MODE"}</Text></View><View style={s.modeSwitch}><TouchableOpacity onPress={() => switchMarketMode("SPOT")} style={[s.modeBtn, marketMode === "SPOT" && s.modeSpot]}><Text style={[s.modeText, marketMode === "SPOT" && {color:C.green}]}>SPOT · HOLD</Text></TouchableOpacity><TouchableOpacity onPress={() => switchMarketMode("FUTURES")} style={[s.modeBtn, marketMode === "FUTURES" && s.modeFutures]}><Text style={[s.modeText, marketMode === "FUTURES" && {color:C.blue}]}>FUTURES · SHORT TERM</Text></TouchableOpacity></View><ScrollView style={s.main} contentContainerStyle={{ paddingBottom: 28 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={manualRefresh} tintColor={C.green} />}><Header title={pageTitle} subtitle={pageSubtitle} />{tab === "HOME" ? renderHome() : tab === "RADAR" ? renderRadar() : tab === "BTC" ? renderBTC() : tab === "ALTS" ? renderAlts() : tab === "MACRO" ? renderMacro() : tab === "SIGNALS" ? renderSignals() : tab === "ASSET" ? renderAsset() : tab === "WATCH" ? renderWatch() : tab === "FAVOURITES" ? renderFavourites() : tab === "DERIVS" ? renderDerivs() : renderJournal()}</ScrollView><ScrollView horizontal style={s.nav} showsHorizontalScrollIndicator={false}>{tabs.map(x => <TouchableOpacity key={x} onPress={() => setTab(x)} style={[s.navItem, tab === x && s.navActive]}><Text style={[s.navText, tab === x && { color: C.green }]}>{x}</Text></TouchableOpacity>)}</ScrollView><View style={s.disclaimer}><Text style={s.disclaimerText}>EDUCATIONAL MARKET RESEARCH · NOT FINANCIAL ADVICE · NO TRADE EXECUTION</Text></View></SafeAreaView>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg }, modeSwitch: { flexDirection: "row", paddingHorizontal: 14, paddingTop: 9, paddingBottom: 3, backgroundColor: C.bg }, modeBtn: { flex: 1, paddingVertical: 10, alignItems: "center", borderWidth: 1, borderColor: C.line, backgroundColor: C.panel, marginRight: 6, borderRadius: 9 }, modeSpot: { borderColor: C.green, backgroundColor: "#102A26" }, modeFutures: { borderColor: C.blue, backgroundColor: "#14253A" }, modeText: { color: C.muted, fontSize: 9, fontWeight: "900", letterSpacing: 0.5 }, topbar: { height: 54, paddingHorizontal: 17, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderColor: C.line },
  brand: { color: C.white, fontSize: 20, fontWeight: "900", letterSpacing: 2 }, topStatus: { color: C.green, fontSize: 9, fontWeight: "900", letterSpacing: 1 }, main: { flex: 1, paddingHorizontal: 14 },
  header: { paddingTop: 18, paddingBottom: 13 }, brandRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, liveDot: { flexDirection: "row", alignItems: "center" }, dot: { width: 6, height: 6, borderRadius: 4, marginRight: 6 }, liveText: { color: C.muted, fontSize: 9, fontWeight: "800" }, pageTitle: { color: C.white, fontSize: 25, fontWeight: "900", marginTop: 14 }, subtitle: { color: C.muted, fontSize: 11, marginTop: 4 }, meta: { color: C.dim, fontSize: 9, marginTop: 9, letterSpacing: 0.5 },
  hero: { backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 16, padding: 17, marginBottom: 12 }, kicker: { color: C.green, fontSize: 9, fontWeight: "900", letterSpacing: 1.1 }, heroTitle: { color: C.white, fontSize: 24, fontWeight: "900", marginTop: 8 }, heroSub: { color: C.muted, fontSize: 11, lineHeight: 17, marginTop: 6 }, heroActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginTop: 15 }, primaryBtn: { backgroundColor: "#174337", borderRadius: 9, paddingVertical: 11, paddingHorizontal: 14, alignSelf: "flex-start" }, primaryText: { color: C.green, fontSize: 9, fontWeight: "900", letterSpacing: 0.6 },
  card: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 12, padding: 13, marginBottom: 9 }, statCard: { width: "48.5%", marginBottom: 0 }, metricsGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", marginTop: 10 }, metric: { width: "31.5%", minHeight: 48, paddingVertical: 5 }, metricLabel: { color: C.dim, fontSize: 8, fontWeight: "800", letterSpacing: 0.5 }, metricValue: { color: C.white, fontSize: 13, fontWeight: "900", marginTop: 5 }, headingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16, marginBottom: 9 }, heading: { color: C.white, fontSize: 12, fontWeight: "900", letterSpacing: 0.7 }, muted: { color: C.muted, fontSize: 10, lineHeight: 16 }, mini: { color: C.dim, fontSize: 9, marginTop: 5 },
  coinRow: { minHeight: 62, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderColor: C.line, paddingVertical: 8 }, coinName: { color: C.white, fontSize: 13, fontWeight: "900" }, coinPrice: { color: C.white, fontSize: 12, fontWeight: "800" }, star: { paddingHorizontal: 9, paddingVertical: 6 }, search: { backgroundColor: C.panel, color: C.white, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, marginBottom: 10, fontSize: 12 }, assetResults: { marginBottom: 8 }, assetResult: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 8, padding: 9, marginBottom: 5, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, pillRow: { flexDirection: "row", flexWrap: "wrap", marginBottom: 8 }, pill: { borderWidth: 1, borderColor: C.line, backgroundColor: C.panel, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 8, marginRight: 6, marginBottom: 6 }, pillActive: { borderColor: C.green, backgroundColor: "#102A26" }, pillText: { color: C.muted, fontSize: 9, fontWeight: "900" },
  split: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, bigPrice: { color: C.white, fontSize: 23, fontWeight: "900", marginTop: 5 }, direction: { fontSize: 12, fontWeight: "900" }, evidenceRow: { flexDirection: "row", paddingVertical: 7, borderBottomWidth: 1, borderColor: C.line }, evidenceIndex: { color: C.green, fontSize: 9, fontWeight: "900", width: 27 }, evidenceText: { color: C.muted, fontSize: 10, flex: 1 }, footnote: { color: C.dim, fontSize: 9, lineHeight: 14, marginTop: 10 },
  signalCard: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 13, marginBottom: 9 }, signalDir: { fontSize: 10, fontWeight: "900", letterSpacing: 0.5 }, signalTf: { color: C.blue, fontSize: 9, fontWeight: "900" }, signalCoin: { color: C.white, fontSize: 19, fontWeight: "900", marginTop: 8 }, signalDesc: { color: C.muted, fontSize: 10, marginTop: 8 }, tap: { color: C.blue, fontSize: 8, fontWeight: "900", marginTop: 10 }, expanded: { borderTopWidth: 1, borderColor: C.line, marginTop: 10, paddingTop: 10 }, body: { color: C.white, fontSize: 12, lineHeight: 19, marginTop: 7 }, progressTrack: { height: 5, backgroundColor: C.line, borderRadius: 5, marginTop: 12, overflow: "hidden" }, progressFill: { height: 5, backgroundColor: C.green },
  nav: { maxHeight: 48, borderTopWidth: 1, borderColor: C.line, backgroundColor: C.bg }, navItem: { paddingHorizontal: 14, paddingVertical: 16, borderTopWidth: 2, borderTopColor: "transparent" }, navActive: { borderTopColor: C.green }, navText: { color: C.dim, fontSize: 9, fontWeight: "900", letterSpacing: 0.5 }, disclaimer: { paddingVertical: 6, alignItems: "center", backgroundColor: "#090F19" }, disclaimerText: { color: C.dim, fontSize: 7, letterSpacing: 0.4 }
});
