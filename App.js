
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, StatusBar, ActivityIndicator, RefreshControl,
  AppState, Platform
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

import {
  analyseCandles,
  analyseSpotCandles,
  combineTimeframes
} from './signalEngine';

const FUTURES = 'https://contract.mexc.com/api/v1/contract';
const SPOT = 'https://api.mexc.com/api/v3';

const COLORS = {
  bg: '#070B13',
  panel: '#101827',
  panel2: '#151F30',
  border: '#243147',
  green: '#38D6A2',
  red: '#FF647C',
  blue: '#55A6FF',
  text: '#F1F5FA',
  muted: '#8290A5',
  yellow: '#F5C76A'
};

const TABS = [
  'HOME', 'FUTURES', 'SPOT', 'SIGNALS',
  'BTC', 'ALTS', 'RADAR', 'DERIVATIVES',
  'WATCHLIST', 'MACRO', 'NEWS', 'JOURNAL'
];

const INTERVALS = {
  '15m': 'Min15',
  '1h': 'Min60',
  '4h': 'Hour4',
  '1d': 'Day1',
  '1w': 'Week1'
};

const fmt = (n, digits = 4) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  return x.toLocaleString('en-US', {
    maximumFractionDigits: digits
  });
};

const pct = n => `${(Number(n) * 100).toFixed(2)}%`;

async function getJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Market API error ${response.status}`);
  }
  return response.json();
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = null;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => run()
    )
  );

  return results;
}

async function getFuturesCandles(symbol, timeframe) {
  const seconds = {
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
    '1d': 86400,
    '1w': 604800
  }[timeframe];

  const end = Math.floor(Date.now() / 1000);
  const start = end - seconds * 260;

  const result = await getJSON(
    `${FUTURES}/kline/${symbol}?interval=${INTERVALS[timeframe]}&start=${start}&end=${end}`
  );

  if (!result.success || !result.data) return [];

  const d = result.data;

  return (d.time || []).map((time, i) => ({
    time: time * 1000,
    open: Number(d.open[i]),
    high: Number(d.high[i]),
    low: Number(d.low[i]),
    close: Number(d.close[i]),
    volume: Number(d.vol[i])
  }));
}

async function getSpotCandles(symbol, timeframe) {
  const interval = {
    '1d': '1d',
    '1w': '1w'
  }[timeframe];

  const data = await getJSON(
    `${SPOT}/klines?symbol=${symbol}&interval=${interval}&limit=260`
  );

  return data.map(x => ({
    time: Number(x[0]),
    open: Number(x[1]),
    high: Number(x[2]),
    low: Number(x[3]),
    close: Number(x[4]),
    volume: Number(x[5])
  }));
}

async function getFuturesMarkets() {
  const result = await getJSON(`${FUTURES}/ticker`);
  const rows = Array.isArray(result.data)
    ? result.data
    : [result.data].filter(Boolean);

  return rows
    .filter(x => x.symbol?.endsWith('_USDT'))
    .sort((a, b) => Number(b.amount24) - Number(a.amount24))
    .slice(0, 100);
}

async function getSpotMarkets() {
  const result = await getJSON(`${SPOT}/ticker/24hr`);

  return result
    .filter(x =>
      x.symbol?.endsWith('USDT') &&
      !x.symbol.includes('UPUSDT') &&
      !x.symbol.includes('DOWNUSDT')
    )
    .sort((a, b) =>
      Number(b.quoteVolume) - Number(a.quoteVolume)
    )
    .slice(0, 30);
}

function makeLevels(result) {
  const entry = result.price;
  const risk = Math.abs(
    entry - result.levels.invalidation
  );

  if (!risk || !Number.isFinite(risk)) return null;

  const direction = result.direction === 'LONG_BIAS';
  const sign = direction ? 1 : -1;

  return {
    entry,
    tp1: entry + sign * risk,
    tp2: entry + sign * risk * 1.5,
    tp3: entry + sign * risk * 2,
    sl: result.levels.invalidation,
    risk
  };
}

async function registerNotifications() {
  if (!Device.isDevice) return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(
      'vortex-signals',
      {
        name: 'VORTEX Signals',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: COLORS.green
      }
    );
  }

  const current = await Notifications.getPermissionsAsync();

  let status = current.status;

  if (status !== 'granted') {
    const requested =
      await Notifications.requestPermissionsAsync();
    status = requested.status;
  }

  return status === 'granted';
}

async function sendSignalNotification(signal) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `VORTEX · ${signal.direction}`,
      body:
        `${signal.symbol} | ${signal.quality} grade | ` +
        `Entry ${fmt(signal.levels.entry)} | ` +
        `SL ${fmt(signal.levels.sl)}`,
      sound: true,
      data: { symbol: signal.symbol }
    },
    trigger: null
  });
}

export default function App() {
  const [tab, setTab] = useState('HOME');
  const [mode, setMode] = useState('FUTURES');

  const [futures, setFutures] = useState([]);
  const [spot, setSpot] = useState([]);
  const [signals, setSignals] = useState([]);
  const [spotSignals, setSpotSignals] = useState([]);

  const [watchlist] = useState([
    'BTC_USDT',
    'ETH_USDT',
    'SOL_USDT'
  ]);

  const [journal, setJournal] = useState('');
  const [entries, setEntries] = useState([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastScan, setLastScan] = useState(null);
  const [notificationEnabled, setNotificationEnabled] =
    useState(false);

  const scanLock = useRef(false);
  const lastScanRef = useRef(0);
  const notified = useRef(new Set());

  async function scanFutures(markets) {
    const candidates = markets
      .filter(x => Number(x.amount24) >= 10000000)
      .slice(0, 12);

    const found = await mapLimit(
      candidates,
      3,
      async market => {
        const frames = {};

        for (const timeframe of ['15m', '1h', '4h', '1d']) {
          const candles = await getFuturesCandles(
            market.symbol,
            timeframe
          );

          frames[timeframe] = analyseCandles(
            candles,
            timeframe
          );
        }

        const combined = combineTimeframes(frames);

        if (!combined.ready || !combined.qualified) {
          return null;
        }

        const main =
          frames['1h']?.qualified
            ? frames['1h']
            : frames['15m'];

        if (!main?.ready) return null;

        const levels = makeLevels(main);
        if (!levels) return null;

        return {
          symbol: market.symbol,
          direction: main.direction === 'LONG_BIAS'
            ? 'LONG'
            : 'SHORT',
          quality: main.quality,
          score: main.score,
          price: main.price,
          timeframe: main.timeframe,
          trend: main.trend,
          regime: main.regime,
          levels,
          combined,
          evidence: main.evidence,
          id: `${market.symbol}-${main.direction}-${Math.floor(main.time / 60000)}`
        };
      }
    );

    return found.filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  async function scanSpot(markets) {
    const candidates = markets.slice(0, 8);

    const found = await mapLimit(
      candidates,
      3,
      async market => {
        const symbol = market.symbol;

        const daily = await getSpotCandles(symbol, '1d');
        const weekly = await getSpotCandles(symbol, '1w');

        const d = analyseSpotCandles(daily, '1d');
        const w = analyseSpotCandles(weekly, '1w');

        if (!d.ready || !w.ready) return null;
        if (!d.qualified || !w.qualified) return null;

        return {
          symbol,
          price: d.price,
          score: d.thesisScore,
          phase: d.phase,
          direction: d.displayDirection,
          evidence: d.evidence,
          id: `${symbol}-SPOT-${Math.floor(d.time / 86400000)}`
        };
      }
    );

    return found.filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  async function runScan() {
    if (scanLock.current) return;

    scanLock.current = true;
    setLoading(true);
    setError('');

    try {
      const [f, s] = await Promise.all([
        getFuturesMarkets(),
        getSpotMarkets()
      ]);

      setFutures(f);
      setSpot(s);

      const [futureResults, spotResults] =
        await Promise.all([
          scanFutures(f),
          scanSpot(s)
        ]);

      setSignals(futureResults);
      setSpotSignals(spotResults);

      // Only notify about newly detected A/B research signals.
      if (notificationEnabled) {
        for (const signal of futureResults) {
          if (
            !notified.current.has(signal.id) &&
            ['A', 'B'].includes(signal.quality)
          ) {
            notified.current.add(signal.id);

            try {
              await sendSignalNotification(signal);
            } catch (e) {
              // Notification delivery is controlled by Android.
            }
          }
        }
      }

      lastScanRef.current = Date.now();
      setLastScan(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e.message || 'Market data unavailable');
    } finally {
      setLoading(false);
      scanLock.current = false;
    }
  }

  useEffect(() => {
    registerNotifications().then(setNotificationEnabled);

    runScan();

    const subscription = AppState.addEventListener(
      'change',
      state => {
        if (
          state === 'active' &&
          Date.now() - lastScanRef.current > 60000
        ) {
          runScan();
        }
      }
    );

    return () => subscription.remove();
  }, []);

  const marketBreadth = futures.length
    ? futures.filter(x => Number(x.riseFallRate) > 0).length /
      futures.length
    : 0;

  const btc = futures.find(x => x.symbol === 'BTC_USDT');

  const marketRegime =
    marketBreadth > 0.65
      ? 'BULLISH BREADTH'
      : marketBreadth < 0.35
        ? 'BEARISH BREADTH'
        : 'MIXED MARKET';

  const selectedMarkets = mode === 'FUTURES'
    ? futures
    : spot;

  const renderCard = (title, value, subtitle, color) => (
    <View style={styles.metric}>
      <Text style={styles.muted}>{title}</Text>
      <Text style={[styles.metricValue, { color: color || COLORS.text }]}>
        {value}
      </Text>
      {!!subtitle && (
        <Text style={styles.muted}>{subtitle}</Text>
      )}
    </View>
  );

  const renderSignal = signal => (
    <View key={signal.id} style={styles.card}>
      <View style={styles.row}>
        <View>
          <Text style={styles.symbol}>{signal.symbol}</Text>
          <Text style={styles.muted}>
            {signal.timeframe} · {signal.quality} grade
          </Text>
        </View>

        <Text style={{
          color: signal.direction === 'LONG'
            ? COLORS.green
            : COLORS.red,
          fontWeight: '900'
        }}>
          {signal.direction}
        </Text>
      </View>

      <View style={styles.divider} />

      <View style={styles.row}>
        <Text style={styles.muted}>Research score</Text>
        <Text style={styles.value}>{signal.score}/100</Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.muted}>Reference entry</Text>
        <Text style={styles.value}>
          {fmt(signal.levels.entry)}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.muted}>TP1</Text>
        <Text style={styles.green}>
          {fmt(signal.levels.tp1)}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.muted}>TP2</Text>
        <Text style={styles.green}>
          {fmt(signal.levels.tp2)}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.muted}>TP3</Text>
        <Text style={styles.green}>
          {fmt(signal.levels.tp3)}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.muted}>Invalidation</Text>
        <Text style={styles.red}>
          {fmt(signal.levels.sl)}
        </Text>
      </View>

      <View style={styles.divider} />

      <Text style={styles.sectionLabel}>TIMEFRAME ALIGNMENT</Text>
      <Text style={styles.body}>
        {signal.combined.summary}
      </Text>

      <Text style={styles.sectionLabel}>RESEARCH EVIDENCE</Text>

      {signal.evidence.map((item, index) => (
        <Text key={index} style={styles.evidence}>
          • {item}
        </Text>
      ))}
    </View>
  );

  const renderMarket = market => {
    const price = mode === 'FUTURES'
      ? market.lastPrice
      : market.lastPrice;

    const change = mode === 'FUTURES'
      ? Number(market.riseFallRate) * 100
      : Number(market.priceChangePercent);

    return (
      <View key={market.symbol} style={styles.marketRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.symbol}>
            {market.symbol}
          </Text>
          <Text style={styles.muted}>
            {fmt(price, 8)}
          </Text>
        </View>

        <Text style={{
          color: change >= 0 ? COLORS.green : COLORS.red,
          fontWeight: '700'
        }}>
          {change >= 0 ? '+' : ''}{change.toFixed(2)}%
        </Text>
      </View>
    );
  };

  function addJournal() {
    if (!journal.trim()) return;

    setEntries(previous => [
      {
        id: Date.now().toString(),
        text: journal.trim(),
        date: new Date().toLocaleString()
      },
      ...previous
    ]);

    setJournal('');
  }

  function renderHome() {
    return (
      <>
        <View style={styles.hero}>
          <Text style={styles.heroSmall}>VORTEX HQ</Text>
          <Text style={styles.heroTitle}>MARKET INTELLIGENCE</Text>
          <Text style={styles.muted}>
            Educational research · MEXC public data
          </Text>
        </View>

        <View style={styles.grid}>
          {renderCard(
            'BTC PRICE',
            btc ? `$${fmt(btc.lastPrice)}` : '—',
            btc ? `${(Number(btc.riseFallRate) * 100).toFixed(2)}% 24h` : ''
          )}
          {renderCard(
            'MARKET BREADTH',
            `${(marketBreadth * 100).toFixed(0)}%`,
            marketRegime
          )}
          {renderCard(
            'FUTURES SIGNALS',
            signals.length,
            'Qualified research setups',
            COLORS.green
          )}
          {renderCard(
            'SPOT THESIS',
            spotSignals.length,
            'Long-horizon research',
            COLORS.blue
          )}
        </View>

        <TouchableOpacity
          style={styles.scanButton}
          onPress={runScan}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#07130F" />
            : <Text style={styles.scanText}>SCAN MARKETS NOW</Text>
          }
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>MARKET REGIME</Text>
        <View style={styles.card}>
          <Text style={styles.value}>{marketRegime}</Text>
          <Text style={styles.body}>
            Based on the proportion of positive 24-hour
            changes among the tracked Futures markets.
          </Text>
        </View>

        <Text style={styles.sectionTitle}>LATEST FUTURES RESEARCH</Text>
        {signals.slice(0, 3).map(renderSignal)}

        <Text style={styles.sectionTitle}>SPOT HOLDING THESIS</Text>
        {spotSignals.slice(0, 3).map(item => (
          <View key={item.id} style={styles.card}>
            <Text style={styles.symbol}>{item.symbol}</Text>
            <Text style={styles.green}>{item.phase}</Text>
            <Text style={styles.body}>
              Thesis checks: {item.score}/4
            </Text>
            {item.evidence.slice(-3).map((e, i) => (
              <Text key={i} style={styles.evidence}>• {e}</Text>
            ))}
          </View>
        ))}
      </>
    );
  }

  function renderRadar() {
    const positive = futures.filter(
      x => Number(x.riseFallRate) > 0
    ).length;

    const negative = futures.filter(
      x => Number(x.riseFallRate) < 0
    ).length;

    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>MARKET RADAR</Text>
        {renderCard('POSITIVE MARKETS', positive)}
        {renderCard('NEGATIVE MARKETS', negative)}
        {renderCard('MARKET BREADTH', `${(marketBreadth * 100).toFixed(1)}%`)}
        <Text style={styles.body}>
          This is a price-breadth radar, not a complete
          macroeconomic or liquidation feed.
        </Text>
      </View>
    );
  }

  function renderDerivatives() {
    return futures.slice(0, 30).map(item => (
      <View key={item.symbol} style={styles.marketRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.symbol}>{item.symbol}</Text>
          <Text style={styles.muted}>
            OI: {fmt(item.holdVol, 2)}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.value}>
            {pct(item.fundingRate)}
          </Text>
          <Text style={styles.muted}>Funding</Text>
        </View>
      </View>
    ));
  }

  function renderJournal() {
    return (
      <>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>RESEARCH JOURNAL</Text>
          <TextInput
            value={journal}
            onChangeText={setJournal}
            placeholder="Write your market observation..."
            placeholderTextColor={COLORS.muted}
            multiline
            style={styles.input}
          />
          <TouchableOpacity
            style={styles.scanButton}
            onPress={addJournal}
          >
            <Text style={styles.scanText}>SAVE NOTE</Text>
          </TouchableOpacity>
        </View>

        {entries.map(item => (
          <View key={item.id} style={styles.card}>
            <Text style={styles.muted}>{item.date}</Text>
            <Text style={styles.body}>{item.text}</Text>
          </View>
        ))}
      </>
    );
  }

  function renderContent() {
    if (loading && !futures.length) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={COLORS.green} />
          <Text style={styles.muted}>
            Connecting to market data...
          </Text>
        </View>
      );
    }

    switch (tab) {
      case 'HOME':
        return renderHome();

      case 'FUTURES':
        return (
          <>
            <Text style={styles.sectionTitle}>
              FUTURES RESEARCH · {signals.length} SETUPS
            </Text>
            {signals.length
              ? signals.map(renderSignal)
              : <Text style={styles.body}>
                  No qualified Futures setups currently.
                </Text>
            }
          </>
        );

      case 'SPOT':
        return (
          <>
            <Text style={styles.sectionTitle}>
              SPOT THESIS · {spotSignals.length} RESULTS
            </Text>
            {spotSignals.map(item => (
              <View key={item.id} style={styles.card}>
                <Text style={styles.symbol}>{item.symbol}</Text>
                <Text style={styles.green}>{item.phase}</Text>
                <Text style={styles.body}>
                  Reference price: {fmt(item.price)}
                </Text>
                <Text style={styles.body}>
                  Thesis checks: {item.score}/4
                </Text>
                {item.evidence.map((e, i) => (
                  <Text key={i} style={styles.evidence}>
                    • {e}
                  </Text>
                ))}
              
