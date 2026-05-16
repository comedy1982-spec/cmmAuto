'use strict';

// ── 설정 ──────────────────────────────────────────────
const BYBIT_API = 'https://api.bybit.com';
const REFRESH_INTERVAL = 30_000; // 30초 자동 갱신

const COINS = [
  { symbol: 'BTCUSDT',  base: 'BTC',  name: 'Bitcoin',      color: '#f7931a', bg: '#3d2d10' },
  { symbol: 'ETHUSDT',  base: 'ETH',  name: 'Ethereum',     color: '#627eea', bg: '#1b2040' },
  { symbol: 'SOLUSDT',  base: 'SOL',  name: 'Solana',       color: '#9945ff', bg: '#2a1a40' },
  { symbol: 'BNBUSDT',  base: 'BNB',  name: 'BNB',          color: '#f0b90b', bg: '#3a2e08' },
  { symbol: 'XRPUSDT',  base: 'XRP',  name: 'XRP',          color: '#00aae4', bg: '#0d2d3a' },
  { symbol: 'ADAUSDT',  base: 'ADA',  name: 'Cardano',      color: '#0033ad', bg: '#0a1535' },
  { symbol: 'DOGEUSDT', base: 'DOGE', name: 'Dogecoin',     color: '#c2a633', bg: '#30280d' },
  { symbol: 'AVAXUSDT', base: 'AVAX', name: 'Avalanche',    color: '#e84142', bg: '#3a1111' },
  { symbol: 'DOTUSDT',  base: 'DOT',  name: 'Polkadot',     color: '#e6007a', bg: '#3a0020' },
  { symbol: 'MATICUSDT',base: 'MATIC',name: 'Polygon',      color: '#8247e5', bg: '#211040' },
  { symbol: 'LTCUSDT',  base: 'LTC',  name: 'Litecoin',     color: '#bfbbbb', bg: '#2a2a2a' },
  { symbol: 'LINKUSDT', base: 'LINK', name: 'Chainlink',    color: '#2a5ada', bg: '#0d1835' },
  { symbol: 'UNIUSDT',  base: 'UNI',  name: 'Uniswap',      color: '#ff007a', bg: '#3a0020' },
  { symbol: 'ATOMUSDT', base: 'ATOM', name: 'Cosmos',       color: '#6f7390', bg: '#1a1c28' },
  { symbol: 'TRXUSDT',  base: 'TRX',  name: 'TRON',         color: '#ef0027', bg: '#3a000a' },
];

const INTERVALS = {
  '1':   { label: '1분',   seconds: 60 },
  '5':   { label: '5분',   seconds: 300 },
  '15':  { label: '15분',  seconds: 900 },
  '30':  { label: '30분',  seconds: 1800 },
  '60':  { label: '1시간', seconds: 3600 },
  '240': { label: '4시간', seconds: 14400 },
  '720': { label: '12시간',seconds: 43200 },
  'D':   { label: '1일',   seconds: 86400 },
  'W':   { label: '1주',   seconds: 604800 },
};

// ── 상태 ──────────────────────────────────────────────
let state = {
  symbol: 'BTCUSDT',
  interval: '60',
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  refreshTimer: null,
  tickerCache: {},
};

// ── 유틸 ──────────────────────────────────────────────
function fmt(n, digits = 2) {
  if (n == null || isNaN(n)) return '-';
  const num = parseFloat(n);
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPrice(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '-';
  if (num >= 10000) return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (num >= 1)     return num.toFixed(4);
  return num.toFixed(6);
}

function fmtVolume(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '-';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

// ── API ──────────────────────────────────────────────
async function fetchKline(symbol, interval, limit = 300) {
  const url = `${BYBIT_API}/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(json.retMsg || 'API error');
  return json.result.list; // [[startTime, open, high, low, close, volume, turnover], ...]
}

async function fetchTicker(symbol) {
  const url = `${BYBIT_API}/v5/market/tickers?category=spot&symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(json.retMsg || 'API error');
  return json.result.list[0];
}

async function fetchAllTickers() {
  const url = `${BYBIT_API}/v5/market/tickers?category=spot`;
  const res = await fetch(url);
  if (!res.ok) return;
  const json = await res.json();
  if (json.retCode !== 0) return;
  json.result.list.forEach(t => { state.tickerCache[t.symbol] = t; });
}

// ── 차트 초기화 ──────────────────────────────────────
function initChart() {
  const chartArea = document.getElementById('chartArea');
  chartArea.innerHTML = '';

  state.chart = LightweightCharts.createChart(chartArea, {
    layout: {
      background: { color: '#0d0f14' },
      textColor: '#8891a8',
    },
    grid: {
      vertLines: { color: '#1a1d27' },
      horzLines: { color: '#1a1d27' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#565e75', width: 1, style: 3 },
      horzLine: { color: '#565e75', width: 1, style: 3 },
    },
    rightPriceScale: {
      borderColor: '#252a3a',
      scaleMargins: { top: 0.08, bottom: 0.25 },
    },
    timeScale: {
      borderColor: '#252a3a',
      timeVisible: true,
      secondsVisible: false,
    },
  });

  state.candleSeries = state.chart.addCandlestickSeries({
    upColor: '#26a17b',
    downColor: '#ef454a',
    borderUpColor: '#26a17b',
    borderDownColor: '#ef454a',
    wickUpColor: '#26a17b',
    wickDownColor: '#ef454a',
  });

  state.volumeSeries = state.chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
    color: '#26a17b',
  });

  state.chart.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });

  // 차트 크기 자동 조정
  const ro = new ResizeObserver(() => {
    if (state.chart) {
      state.chart.applyOptions({
        width: chartArea.clientWidth,
        height: chartArea.clientHeight,
      });
    }
  });
  ro.observe(chartArea);
  state.chart.applyOptions({
    width: chartArea.clientWidth,
    height: chartArea.clientHeight,
  });

  // 크로스헤어 이동 시 스탯 업데이트
  state.chart.subscribeCrosshairMove(p => {
    if (p.seriesData && p.seriesData.has(state.candleSeries)) {
      const d = p.seriesData.get(state.candleSeries);
      if (d) {
        document.getElementById('statOpen').textContent  = fmtPrice(d.open);
        document.getElementById('statHigh').textContent  = fmtPrice(d.high);
        document.getElementById('statLow').textContent   = fmtPrice(d.low);
        document.getElementById('statClose').textContent = fmtPrice(d.close);
      }
      if (p.seriesData.has(state.volumeSeries)) {
        const v = p.seriesData.get(state.volumeSeries);
        if (v) document.getElementById('statVolume').textContent = fmtVolume(v.value);
      }
    }
  });
}

// ── 차트 데이터 로드 ──────────────────────────────────
async function loadChart() {
  showOverlay(true);
  try {
    const raw = await fetchKline(state.symbol, state.interval);

    // Bybit는 최신→과거 순서로 반환하므로 역순 정렬
    const sorted = [...raw].reverse();

    const candles = sorted.map(([t, o, h, l, c]) => ({
      time: Math.floor(parseInt(t) / 1000),
      open:  parseFloat(o),
      high:  parseFloat(h),
      low:   parseFloat(l),
      close: parseFloat(c),
    }));

    const volumes = sorted.map(([t, o, h, l, c, v]) => ({
      time:  Math.floor(parseInt(t) / 1000),
      value: parseFloat(v),
      color: parseFloat(c) >= parseFloat(o) ? 'rgba(38,161,123,0.5)' : 'rgba(239,69,74,0.5)',
    }));

    state.candleSeries.setData(candles);
    state.volumeSeries.setData(volumes);
    state.chart.timeScale().fitContent();

    // 마지막 캔들로 스탯 업데이트
    const last = candles[candles.length - 1];
    if (last) {
      document.getElementById('statOpen').textContent  = fmtPrice(last.open);
      document.getElementById('statHigh').textContent  = fmtPrice(last.high);
      document.getElementById('statLow').textContent   = fmtPrice(last.low);
      document.getElementById('statClose').textContent = fmtPrice(last.close);
      const lastVol = volumes[volumes.length - 1];
      if (lastVol) document.getElementById('statVolume').textContent = fmtVolume(lastVol.value);
    }

    await updateTicker();
    showOverlay(false);
    updateLastUpdate();
  } catch (err) {
    console.error('차트 로드 실패:', err);
    showOverlay(false);
  }
}

// ── 티커 업데이트 ──────────────────────────────────────
async function updateTicker() {
  try {
    const t = await fetchTicker(state.symbol);
    if (!t) return;

    const price  = parseFloat(t.lastPrice);
    const change = parseFloat(t.price24hPcnt) * 100;
    const isPos  = change >= 0;

    document.getElementById('currentSymbol').textContent = state.symbol;
    document.getElementById('currentPrice').textContent  = fmtPrice(price);

    const changeEl = document.getElementById('priceChange');
    changeEl.textContent = (isPos ? '+' : '') + change.toFixed(2) + '%';
    changeEl.className   = 'coin-change ' + (isPos ? 'positive' : 'negative');

    document.getElementById('stat24High').textContent     = fmtPrice(t.highPrice24h);
    document.getElementById('stat24Low').textContent      = fmtPrice(t.lowPrice24h);
    document.getElementById('stat24Turnover').textContent = fmtVolume(t.turnover24h);

    // 사이드바 해당 코인도 업데이트
    state.tickerCache[state.symbol] = t;
    updateCoinItem(state.symbol, t);
  } catch (err) {
    console.error('티커 업데이트 실패:', err);
  }
}

function updateCoinItem(symbol, t) {
  const el = document.querySelector(`.coin-item[data-symbol="${symbol}"]`);
  if (!el) return;
  const price  = parseFloat(t.lastPrice);
  const change = parseFloat(t.price24hPcnt) * 100;
  const isPos  = change >= 0;
  const priceEl  = el.querySelector('.coin-price-small');
  const changeEl = el.querySelector('.coin-change-small');
  if (priceEl)  priceEl.textContent  = fmtPrice(price);
  if (changeEl) {
    changeEl.textContent = (isPos ? '+' : '') + change.toFixed(2) + '%';
    changeEl.className   = 'coin-change-small ' + (isPos ? 'pos' : 'neg');
  }
}

// ── 사이드바 ──────────────────────────────────────────
function buildCoinList(filter = '') {
  const list = document.getElementById('coinList');
  const filtered = filter
    ? COINS.filter(c => c.base.toLowerCase().includes(filter.toLowerCase()) || c.name.toLowerCase().includes(filter.toLowerCase()))
    : COINS;

  list.innerHTML = filtered.map(coin => {
    const t       = state.tickerCache[coin.symbol];
    const price   = t ? fmtPrice(parseFloat(t.lastPrice)) : '...';
    const change  = t ? parseFloat(t.price24hPcnt) * 100 : null;
    const isPos   = change !== null && change >= 0;
    const changeStr = change !== null ? (isPos ? '+' : '') + change.toFixed(2) + '%' : '...';

    return `
    <div class="coin-item ${coin.symbol === state.symbol ? 'active' : ''}" data-symbol="${coin.symbol}">
      <div class="coin-left">
        <div class="coin-icon" style="background:${coin.bg};color:${coin.color}">${coin.base.slice(0, 3)}</div>
        <div class="coin-name-wrap">
          <span class="coin-base">${coin.base}</span>
          <span class="coin-full">${coin.name}</span>
        </div>
      </div>
      <div class="coin-right">
        <span class="coin-price-small">${price}</span>
        <span class="coin-change-small ${change !== null ? (isPos ? 'pos' : 'neg') : ''}">${changeStr}</span>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.coin-item').forEach(el => {
    el.addEventListener('click', () => {
      const sym = el.dataset.symbol;
      if (sym === state.symbol) return;
      state.symbol = sym;
      buildCoinList(document.getElementById('coinSearch').value);
      loadChart();
    });
  });
}

// ── 오버레이 ──────────────────────────────────────────
function showOverlay(show) {
  const el = document.getElementById('chartOverlay');
  el.classList.toggle('hidden', !show);
}

// ── 타임스탬프 ──────────────────────────────────────
function updateLastUpdate() {
  const now = new Date();
  document.getElementById('lastUpdate').textContent =
    '갱신: ' + now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── 자동 갱신 ──────────────────────────────────────────
function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(async () => {
    if (!document.getElementById('autoRefresh').checked) return;
    try {
      // 최신 캔들 1개만 가져와서 업데이트
      const raw   = await fetchKline(state.symbol, state.interval, 2);
      const sorted = [...raw].reverse();
      sorted.forEach(([t, o, h, l, c, v]) => {
        const candle = {
          time:  Math.floor(parseInt(t) / 1000),
          open:  parseFloat(o),
          high:  parseFloat(h),
          low:   parseFloat(l),
          close: parseFloat(c),
        };
        const volume = {
          time:  Math.floor(parseInt(t) / 1000),
          value: parseFloat(v),
          color: parseFloat(c) >= parseFloat(o) ? 'rgba(38,161,123,0.5)' : 'rgba(239,69,74,0.5)',
        };
        if (state.candleSeries) state.candleSeries.update(candle);
        if (state.volumeSeries) state.volumeSeries.update(volume);
      });
      await updateTicker();
      updateLastUpdate();
    } catch (err) {
      console.error('자동 갱신 오류:', err);
    }
  }, REFRESH_INTERVAL);
}

// ── 초기화 ──────────────────────────────────────────
async function init() {
  // 차트 생성
  initChart();

  // 인터벌 버튼 이벤트
  document.getElementById('intervalSelector').addEventListener('click', e => {
    const btn = e.target.closest('.interval-btn');
    if (!btn) return;
    document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.interval = btn.dataset.interval;
    loadChart();
  });

  // 검색
  document.getElementById('coinSearch').addEventListener('input', e => {
    buildCoinList(e.target.value);
  });

  // 초기 사이드바 렌더링 (티커 없이 먼저)
  buildCoinList();

  // 티커 전체 가져오기 → 사이드바 가격 업데이트
  await fetchAllTickers();
  buildCoinList();

  // 차트 로드
  await loadChart();

  // 자동 갱신 시작
  startAutoRefresh();
}

document.addEventListener('DOMContentLoaded', init);
