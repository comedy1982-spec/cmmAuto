/* cmmAuto 차트 뷰어 프론트엔드
 *
 * - /api/meta 로 거래소/심볼/타임프레임 목록과 수집기 상태를 받아 툴바 구성
 * - /api/candles 로 캔들을 받아 lightweight-charts 캔들 + 거래량 시리즈 렌더
 * - 왼쪽 끝으로 스크롤하면 과거 캔들을 추가 로드 (무한 히스토리)
 * - LIVE_POLL_MS 주기로 마지막 캔들을 갱신해 실시간처럼 동작
 */

const LIVE_POLL_MS = 5000;
const META_POLL_MS = 15000;
const PAGE_SIZE = 600;

// 검증된 상승/하락 색 (다크 표면 #131722 기준 대비·CVD 분리 PASS)
const UP = "#26a69a";
const DOWN = "#ef5350";

const els = {
  exchange: document.getElementById("exchange-select"),
  symbol: document.getElementById("symbol-select"),
  tfGroup: document.getElementById("timeframe-group"),
  lastPrice: document.getElementById("last-price"),
  priceChange: document.getElementById("price-change"),
  priceBox: document.getElementById("price-box"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  legend: document.getElementById("legend"),
  emptyHint: document.getElementById("empty-hint"),
};

const state = {
  meta: null,
  exchange: null,
  symbol: null,
  timeframe: null,
  bars: [],            // 오름차순 캔들 (API 형식 그대로)
  loadingOlder: false,
  hasMoreHistory: true,
  loadToken: 0,        // 선택 변경 시 진행 중이던 응답 무시용
};

/* ---------- 차트 초기화 ---------- */

const chart = LightweightCharts.createChart(document.getElementById("chart"), {
  layout: {
    background: { type: "solid", color: "#131722" },
    textColor: "#787b86",
    fontSize: 12,
  },
  grid: {
    vertLines: { color: "#1e222d" },
    horzLines: { color: "#1e222d" },
  },
  crosshair: {
    mode: LightweightCharts.CrosshairMode.Normal,
    vertLine: { color: "#4c525e", labelBackgroundColor: "#2a2e39" },
    horzLine: { color: "#4c525e", labelBackgroundColor: "#2a2e39" },
  },
  rightPriceScale: { borderColor: "#2a2e39" },
  timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false },
  localization: { locale: "ko-KR" },
});

const candleSeries = chart.addCandlestickSeries({
  upColor: UP, downColor: DOWN,
  wickUpColor: UP, wickDownColor: DOWN,
  borderVisible: false,
});

const volumeSeries = chart.addHistogramSeries({
  priceScaleId: "volume",
  priceFormat: { type: "volume" },
  lastValueVisible: false,
  priceLineVisible: false,
});
chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

new ResizeObserver(() => {
  const wrap = document.getElementById("chart-wrap");
  chart.resize(wrap.clientWidth, wrap.clientHeight);
}).observe(document.getElementById("chart-wrap"));

/* ---------- 유틸 ---------- */

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

function candlePoint(b) {
  return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
}

function volumePoint(b) {
  const up = b.close >= b.open;
  return { time: b.time, value: b.volume, color: up ? "rgba(38,166,154,0.45)" : "rgba(239,83,80,0.45)" };
}

// 데이터에 맞는 소수 자릿수 추정 (KRW 정수가·소액 알트코인 모두 대응)
// 실제 표기 자릿수와 가격 크기 기반 상한 중 작은 쪽을 쓴다.
function inferPrecision(bars) {
  if (bars.length === 0) return 2;
  let seen = 0;
  for (const b of bars.slice(-80)) {
    const s = String(b.close);
    const i = s.indexOf(".");
    if (i >= 0) seen = Math.max(seen, Math.min(8, s.length - i - 1));
  }
  const price = Math.abs(bars[bars.length - 1].close);
  const cap = price >= 1000 ? 2 : price >= 1 ? 4 : 8;
  return Math.min(seen, cap);
}

const numFmt = (precision) =>
  new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 0, maximumFractionDigits: precision });

let fmt = numFmt(2);

/* ---------- 데이터 로드 ---------- */

function candlesUrl(extra = "") {
  const { exchange, symbol, timeframe } = state;
  return `/api/candles?exchange=${encodeURIComponent(exchange)}&symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}${extra}`;
}

async function loadInitial() {
  const token = ++state.loadToken;
  state.bars = [];
  state.hasMoreHistory = true;
  candleSeries.setData([]);
  volumeSeries.setData([]);
  els.priceBox.hidden = true;
  els.legend.textContent = "";

  const data = await api(candlesUrl(`&limit=${PAGE_SIZE}`));
  if (token !== state.loadToken) return; // 선택이 바뀌었으면 폐기

  state.bars = data.candles;
  state.hasMoreHistory = data.candles.length >= PAGE_SIZE;
  els.emptyHint.hidden = state.bars.length > 0;

  const precision = inferPrecision(state.bars);
  fmt = numFmt(precision);
  candleSeries.applyOptions({
    priceFormat: { type: "price", precision, minMove: precision ? Math.pow(10, -precision) : 1 },
  });

  candleSeries.setData(state.bars.map(candlePoint));
  volumeSeries.setData(state.bars.map(volumePoint));
  // 최근 150봉만 보이게 시작 (전체를 펼치면 왼쪽 끝에 닿아 과거 로드가 연쇄됨)
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, state.bars.length - 150),
    to: state.bars.length + 5,
  });
  updatePriceBox();
}

async function loadOlder() {
  if (state.loadingOlder || !state.hasMoreHistory || state.bars.length === 0) return;
  state.loadingOlder = true;
  const token = state.loadToken;
  try {
    const oldest = state.bars[0].time;
    const data = await api(candlesUrl(`&limit=${PAGE_SIZE}&before=${oldest}`));
    if (token !== state.loadToken) return;
    if (data.candles.length === 0) {
      state.hasMoreHistory = false;
      return;
    }
    state.bars = data.candles.concat(state.bars);
    state.hasMoreHistory = data.candles.length >= PAGE_SIZE;
    candleSeries.setData(state.bars.map(candlePoint));
    volumeSeries.setData(state.bars.map(volumePoint));
  } finally {
    state.loadingOlder = false;
  }
}

chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
  if (range && range.from < 15) loadOlder();
});

async function pollLive() {
  if (!state.exchange || state.bars.length === 0) return;
  const token = state.loadToken;
  try {
    const data = await api(candlesUrl("&limit=3"));
    if (token !== state.loadToken || data.candles.length === 0) return;
    const lastKnown = state.bars[state.bars.length - 1].time;
    for (const b of data.candles) {
      if (b.time < lastKnown) continue;
      if (b.time === lastKnown) {
        state.bars[state.bars.length - 1] = b;
      } else {
        state.bars.push(b);
      }
      candleSeries.update(candlePoint(b));
      volumeSeries.update(volumePoint(b));
    }
    els.emptyHint.hidden = true;
    updatePriceBox();
  } catch {
    /* 일시적 네트워크 오류는 다음 폴링에서 회복 */
  }
}

/* ---------- 툴바 ---------- */

function exchangeMeta() {
  return state.meta?.exchanges?.[state.exchange];
}

function renderExchangeOptions() {
  els.exchange.innerHTML = "";
  for (const exId of Object.keys(state.meta.exchanges)) {
    const opt = document.createElement("option");
    opt.value = exId;
    opt.textContent = exId;
    els.exchange.appendChild(opt);
  }
  els.exchange.value = state.exchange;
}

function renderSymbolOptions() {
  els.symbol.innerHTML = "";
  for (const sym of exchangeMeta()?.symbols ?? []) {
    const opt = document.createElement("option");
    opt.value = sym;
    opt.textContent = sym;
    els.symbol.appendChild(opt);
  }
  els.symbol.value = state.symbol;
}

function renderTimeframes() {
  els.tfGroup.innerHTML = "";
  const supported = new Set(exchangeMeta()?.status?.timeframes ?? state.meta.timeframes);
  for (const tf of state.meta.timeframes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = tf;
    btn.disabled = !supported.has(tf);
    btn.classList.toggle("active", tf === state.timeframe);
    btn.addEventListener("click", () => {
      state.timeframe = tf;
      renderTimeframes();
      loadInitial();
    });
    els.tfGroup.appendChild(btn);
  }
}

function firstSupportedTimeframe() {
  const supported = new Set(exchangeMeta()?.status?.timeframes ?? state.meta.timeframes);
  if (supported.has(state.timeframe)) return state.timeframe;
  return state.meta.timeframes.find((tf) => supported.has(tf)) ?? state.meta.timeframes[0];
}

els.exchange.addEventListener("change", () => {
  state.exchange = els.exchange.value;
  state.symbol = exchangeMeta()?.symbols?.[0] ?? null;
  state.timeframe = firstSupportedTimeframe();
  renderSymbolOptions();
  renderTimeframes();
  loadInitial();
});

els.symbol.addEventListener("change", () => {
  state.symbol = els.symbol.value;
  loadInitial();
});

/* ---------- 가격/상태/범례 표시 ---------- */

function updatePriceBox() {
  if (state.bars.length === 0) return;
  const last = state.bars[state.bars.length - 1];
  const prev = state.bars.length > 1 ? state.bars[state.bars.length - 2] : last;
  const diff = last.close - prev.close;
  const pct = prev.close ? (diff / prev.close) * 100 : 0;
  els.priceBox.hidden = false;
  els.lastPrice.textContent = fmt.format(last.close);
  els.priceChange.textContent = `${fmt.format(Math.abs(diff))} (${Math.abs(pct).toFixed(2)}%)`;
  els.priceChange.className = `price-change ${diff >= 0 ? "up" : "down"}`;
  document.title = `${fmt.format(last.close)} · ${state.symbol} · ${state.exchange} — cmmAuto`;
}

chart.subscribeCrosshairMove((param) => {
  const bar = param.time != null ? param.seriesData.get(candleSeries) : null;
  const src = bar ?? (state.bars.length ? candlePoint(state.bars[state.bars.length - 1]) : null);
  if (!src) { els.legend.textContent = ""; return; }
  const cls = src.close >= src.open ? "v-up" : "v-down";
  els.legend.innerHTML =
    `<b>${state.symbol}</b> · ${state.timeframe} &nbsp; ` +
    `시 <span class="${cls}">${fmt.format(src.open)}</span> ` +
    `고 <span class="${cls}">${fmt.format(src.high)}</span> ` +
    `저 <span class="${cls}">${fmt.format(src.low)}</span> ` +
    `종 <span class="${cls}">${fmt.format(src.close)}</span>`;
});

async function refreshMeta() {
  try {
    state.meta = await api("/api/meta");
  } catch {
    els.statusDot.className = "dot dot-error";
    els.statusText.textContent = "서버 연결 끊김";
    return;
  }
  const st = exchangeMeta()?.status ?? {};
  if (st.last_error) {
    els.statusDot.className = "dot dot-error";
    els.statusText.textContent = `수집 오류: ${st.last_error}`.slice(0, 80);
  } else if (st.last_sync) {
    const ago = Math.max(0, state.meta.server_time - st.last_sync);
    els.statusDot.className = "dot dot-ok";
    els.statusText.textContent = `동기화 ${ago}s 전`;
  } else {
    els.statusDot.className = "dot dot-unknown";
    els.statusText.textContent = "첫 수집 진행 중…";
  }
}

/* ---------- 부트스트랩 ---------- */

async function init() {
  state.meta = await api("/api/meta");
  const exchangeIds = Object.keys(state.meta.exchanges);
  state.exchange = exchangeIds[0] ?? null;
  state.symbol = exchangeMeta()?.symbols?.[0] ?? null;
  state.timeframe = firstSupportedTimeframe();

  renderExchangeOptions();
  renderSymbolOptions();
  renderTimeframes();
  await refreshMeta();
  await loadInitial();

  setInterval(pollLive, LIVE_POLL_MS);
  setInterval(refreshMeta, META_POLL_MS);
}

init().catch((e) => {
  els.statusDot.className = "dot dot-error";
  els.statusText.textContent = `초기화 실패: ${e.message}`;
});
