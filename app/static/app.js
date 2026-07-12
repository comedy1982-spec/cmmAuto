/* cmmAuto 차트 뷰어 프론트엔드
 *
 * - /api/meta 로 거래소/심볼/타임프레임 목록과 수집기 상태를 받아 툴바 구성
 * - /api/candles 로 캔들을 받아 lightweight-charts 캔들 + 거래량 시리즈 렌더
 * - 왼쪽 끝으로 스크롤하면 과거 캔들을 추가 로드 (무한 히스토리)
 * - LIVE_POLL_MS 주기로 마지막 캔들을 갱신해 실시간처럼 동작
 * - 지표: 이동평균선(SMA/EMA ×4), Envelope, 볼린저밴드, 거래량, RSI, MACD
 *   — "지표" 패널에서 켜고 끄며 설정은 localStorage에 저장
 */

const LIVE_POLL_MS = 5000;
const META_POLL_MS = 15000;
const PAGE_SIZE = 600;

// 검증된 상승/하락 색 (다크 표면 #131722 기준 대비·CVD 분리 PASS)
const UP = "#26a69a";
const DOWN = "#ef5350";
// 이동평균선 슬롯별 고정 색 (다크 표면 기준 검증 통과 팔레트 — 순서 고정, 순환 금지)
const MA_COLORS = ["#d97706", "#3b82f6", "#db2777", "#8b5cf6"];
const BAND_COLOR = "#7c8aa0"; // Envelope/볼린저 밴드용 중립 회청색

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
  indicatorBtn: document.getElementById("indicator-btn"),
  indicatorPanel: document.getElementById("indicator-panel"),
  rsiPane: document.getElementById("rsi-pane"),
  rsiLabel: document.getElementById("rsi-label"),
  macdPane: document.getElementById("macd-pane"),
  macdLabel: document.getElementById("macd-label"),
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

/* ---------- 지표 설정 (localStorage 저장) ---------- */

const SETTINGS_KEY = "cmmauto.indicators.v1";

const DEFAULT_SETTINGS = {
  ma: [
    { on: true, type: "SMA", period: 5 },
    { on: true, type: "SMA", period: 20 },
    { on: false, type: "SMA", period: 60 },
    { on: false, type: "SMA", period: 120 },
  ],
  envelope: { on: false, period: 20, percent: 2.5 },
  bollinger: { on: false, period: 20, mult: 2 },
  volume: { on: true },
  rsi: { on: false, period: 14 },
  macd: { on: false, fast: 12, slow: 26, signal: 9 },
};

function loadSettings() {
  const base = structuredClone(DEFAULT_SETTINGS);
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (!saved) return base;
    for (let i = 0; i < base.ma.length; i++) Object.assign(base.ma[i], saved.ma?.[i]);
    Object.assign(base.envelope, saved.envelope);
    Object.assign(base.bollinger, saved.bollinger);
    Object.assign(base.volume, saved.volume);
    Object.assign(base.rsi, saved.rsi);
    Object.assign(base.macd, saved.macd);
  } catch { /* 손상된 저장값은 기본값으로 */ }
  return base;
}

let settings = loadSettings();

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/* ---------- 차트 초기화 (메인 + RSI/MACD 서브 패널) ---------- */

const PRICE_SCALE_WIDTH = 84; // 패널 간 시간축 정렬을 위해 모든 패널의 가격축 폭을 통일

function baseChartOptions() {
  return {
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
    rightPriceScale: { borderColor: "#2a2e39", minimumWidth: PRICE_SCALE_WIDTH },
    timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false },
    localization: { locale: "ko-KR" },
  };
}

const chart = LightweightCharts.createChart(document.getElementById("chart"), baseChartOptions());

// 서브 패널은 메인 차트의 시간 범위를 따라가는 수동 디스플레이 (직접 스크롤/줌 불가)
const subChartOptions = () => ({
  ...baseChartOptions(),
  timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, visible: false },
  handleScroll: false,
  handleScale: false,
});

const rsiChart = LightweightCharts.createChart(document.getElementById("rsi-chart"), subChartOptions());
const macdChart = LightweightCharts.createChart(document.getElementById("macd-chart"), subChartOptions());

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

// 지표 시리즈는 설정에 따라 생성/제거한다
const ind = {
  ma: [null, null, null, null],
  envUpper: null, envLower: null,
  bbUpper: null, bbMiddle: null, bbLower: null,
  rsi: null,
  macdLine: null, macdSignal: null, macdHist: null,
};

for (const [paneId, paneChart] of [["main-pane", chart], ["rsi-pane", rsiChart], ["macd-pane", macdChart]]) {
  const el = document.getElementById(paneId);
  new ResizeObserver(() => paneChart.resize(el.clientWidth, el.clientHeight)).observe(el);
}

// 시간축 동기화: 메인 → 서브 단방향.
// (range 이벤트가 비동기로 발생하므로 양방향 동기화는 setData 시
//  서브 패널의 초기 범위가 메인으로 역전파되는 문제를 일으킨다)
function pushRangeToSubs() {
  const r = chart.timeScale().getVisibleLogicalRange();
  if (!r) return;
  rsiChart.timeScale().setVisibleLogicalRange(r);
  macdChart.timeScale().setVisibleLogicalRange(r);
}
chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
  if (!range) return;
  rsiChart.timeScale().setVisibleLogicalRange(range);
  macdChart.timeScale().setVisibleLogicalRange(range);
});

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

/* ---------- 지표 시리즈 생성/제거 및 재계산 ---------- */

const lineDefaults = {
  lineWidth: 1,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
};

function addLine(target, color, extra = {}) {
  return target.addLineSeries({ ...lineDefaults, color, ...extra });
}

function removeSeries(target, key) {
  if (ind[key]) {
    target.removeSeries(ind[key]);
    ind[key] = null;
  }
}

/** 설정에 맞게 시리즈를 만들거나 제거하고 서브 패널 표시를 갱신한다 */
function syncIndicatorSeries() {
  // 이동평균선
  settings.ma.forEach((m, i) => {
    if (m.on && !ind.ma[i]) ind.ma[i] = addLine(chart, MA_COLORS[i], { lineWidth: 2 });
    if (!m.on && ind.ma[i]) { chart.removeSeries(ind.ma[i]); ind.ma[i] = null; }
  });

  // Envelope
  if (settings.envelope.on) {
    if (!ind.envUpper) ind.envUpper = addLine(chart, BAND_COLOR, { lineStyle: LightweightCharts.LineStyle.Dashed });
    if (!ind.envLower) ind.envLower = addLine(chart, BAND_COLOR, { lineStyle: LightweightCharts.LineStyle.Dashed });
  } else {
    removeSeries(chart, "envUpper");
    removeSeries(chart, "envLower");
  }

  // 볼린저밴드
  if (settings.bollinger.on) {
    if (!ind.bbUpper) ind.bbUpper = addLine(chart, BAND_COLOR, { lineStyle: LightweightCharts.LineStyle.Dotted });
    if (!ind.bbMiddle) ind.bbMiddle = addLine(chart, BAND_COLOR);
    if (!ind.bbLower) ind.bbLower = addLine(chart, BAND_COLOR, { lineStyle: LightweightCharts.LineStyle.Dotted });
  } else {
    removeSeries(chart, "bbUpper");
    removeSeries(chart, "bbMiddle");
    removeSeries(chart, "bbLower");
  }

  // 거래량
  volumeSeries.applyOptions({ visible: settings.volume.on });

  // RSI 서브 패널
  els.rsiPane.hidden = !settings.rsi.on;
  if (settings.rsi.on) {
    if (!ind.rsi) {
      ind.rsi = addLine(rsiChart, "#8b5cf6", { lineWidth: 2, lastValueVisible: true });
      ind.rsi.createPriceLine({ price: 70, color: "#4c525e", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false });
      ind.rsi.createPriceLine({ price: 30, color: "#4c525e", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false });
    }
    els.rsiLabel.textContent = `RSI ${settings.rsi.period}`;
  } else {
    removeSeries(rsiChart, "rsi");
  }

  // MACD 서브 패널
  els.macdPane.hidden = !settings.macd.on;
  if (settings.macd.on) {
    if (!ind.macdHist) {
      ind.macdHist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      ind.macdLine = addLine(macdChart, "#3b82f6", { lineWidth: 2, lastValueVisible: true });
      ind.macdSignal = addLine(macdChart, "#d97706", { lineWidth: 1 });
    }
    els.macdLabel.textContent = `MACD ${settings.macd.fast},${settings.macd.slow},${settings.macd.signal}`;
  } else {
    removeSeries(macdChart, "macdHist");
    removeSeries(macdChart, "macdLine");
    removeSeries(macdChart, "macdSignal");
  }

  // 시간축은 가장 아래에 보이는 패널에만 표시
  const lowest = settings.macd.on ? "macd" : settings.rsi.on ? "rsi" : "main";
  chart.timeScale().applyOptions({ visible: lowest === "main" });
  rsiChart.timeScale().applyOptions({ visible: lowest === "rsi" });
  macdChart.timeScale().applyOptions({ visible: lowest === "macd" });
}

/** 현재 캔들 데이터로 활성 지표를 전부 다시 계산해 시리즈에 반영한다.
 * setData 후 서브 패널의 범위가 초기화될 수 있으므로 메인 범위를 다시 밀어준다. */
function recomputeIndicators() {
  try {
    recomputeIndicatorsInner();
  } finally {
    // 첫 setData 시 서브 차트가 자체적으로 "전체 보기"로 초기화하는 동작이
    // 비동기로 늦게 적용될 수 있어, 즉시 + 다음 프레임에 한 번 더 맞춘다.
    pushRangeToSubs();
    requestAnimationFrame(pushRangeToSubs);
  }
}

/** 서브 패널 시리즈용: 지표 워밍업 구간을 whitespace 포인트로 채워
 * 메인 차트와 데이터 포인트 수(논리 인덱스)를 1:1로 맞춘다. */
function withWarmupWhitespace(bars, points) {
  if (points.length === 0) return points;
  const first = points[0].time;
  const pad = [];
  for (const b of bars) {
    if (b.time >= first) break;
    pad.push({ time: b.time });
  }
  return pad.concat(points);
}

function recomputeIndicatorsInner() {
  const bars = state.bars;
  settings.ma.forEach((m, i) => {
    if (ind.ma[i]) ind.ma[i].setData(bars.length ? Indicators.ma(bars, m.period, m.type) : []);
  });
  if (ind.envUpper) {
    const env = bars.length ? Indicators.envelope(bars, settings.envelope.period, settings.envelope.percent) : { upper: [], lower: [] };
    ind.envUpper.setData(env.upper);
    ind.envLower.setData(env.lower);
  }
  if (ind.bbUpper) {
    const bb = bars.length ? Indicators.bollinger(bars, settings.bollinger.period, settings.bollinger.mult) : { upper: [], middle: [], lower: [] };
    ind.bbUpper.setData(bb.upper);
    ind.bbMiddle.setData(bb.middle);
    ind.bbLower.setData(bb.lower);
  }
  if (ind.rsi) {
    ind.rsi.setData(bars.length ? withWarmupWhitespace(bars, Indicators.rsi(bars, settings.rsi.period)) : []);
  }
  if (ind.macdHist) {
    const m = bars.length
      ? Indicators.macd(bars, settings.macd.fast, settings.macd.slow, settings.macd.signal, "rgba(38,166,154,0.5)", "rgba(239,83,80,0.5)")
      : { macd: [], signal: [], hist: [] };
    ind.macdHist.setData(withWarmupWhitespace(bars, m.hist));
    ind.macdLine.setData(withWarmupWhitespace(bars, m.macd));
    ind.macdSignal.setData(withWarmupWhitespace(bars, m.signal));
  }
}

function applyIndicatorSettings() {
  saveSettings();
  syncIndicatorSeries();
  recomputeIndicators();
  renderLegend(null);
}

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
  recomputeIndicators();
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
  recomputeIndicators();
  // 최근 150봉만 보이게 시작 (전체를 펼치면 왼쪽 끝에 닿아 과거 로드가 연쇄됨)
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, state.bars.length - 150),
    to: state.bars.length + 5,
  });
  updatePriceBox();
  renderLegend(null);
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
    recomputeIndicators();
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
    let changed = false;
    for (const b of data.candles) {
      if (b.time < lastKnown) continue;
      if (b.time === lastKnown) {
        state.bars[state.bars.length - 1] = b;
      } else {
        state.bars.push(b);
      }
      candleSeries.update(candlePoint(b));
      volumeSeries.update(volumePoint(b));
      changed = true;
    }
    if (changed) recomputeIndicators();
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

/* ---------- 지표 설정 패널 ---------- */

function numberInput(value, min, max, step, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = min; input.max = max; input.step = step;
  input.value = value;
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
    else input.value = value;
  });
  return input;
}

function checkboxLabel(text, checked, onChange) {
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  label.appendChild(cb);
  label.appendChild(document.createTextNode(text));
  return label;
}

function buildIndicatorPanel() {
  const panel = els.indicatorPanel;
  panel.innerHTML = "";

  // 이동평균선
  const maSection = document.createElement("div");
  maSection.className = "ind-section";
  maSection.innerHTML = `<div class="ind-title">이동평균선</div>`;
  settings.ma.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "ind-row";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = MA_COLORS[i];
    row.appendChild(swatch);
    row.appendChild(checkboxLabel("", m.on, (v) => { m.on = v; applyIndicatorSettings(); }));
    const typeSel = document.createElement("select");
    for (const t of ["SMA", "EMA"]) {
      const o = document.createElement("option");
      o.value = t; o.textContent = t;
      typeSel.appendChild(o);
    }
    typeSel.value = m.type;
    typeSel.addEventListener("change", () => { m.type = typeSel.value; applyIndicatorSettings(); });
    row.appendChild(typeSel);
    row.appendChild(numberInput(m.period, 1, 400, 1, (v) => { m.period = v; applyIndicatorSettings(); }));
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = "기간";
    row.appendChild(sub);
    maSection.appendChild(row);
  });
  panel.appendChild(maSection);

  // Envelope
  const envSection = document.createElement("div");
  envSection.className = "ind-section";
  const envRow = document.createElement("div");
  envRow.className = "ind-row";
  envRow.appendChild(checkboxLabel("Envelope", settings.envelope.on, (v) => { settings.envelope.on = v; applyIndicatorSettings(); }));
  envRow.appendChild(numberInput(settings.envelope.period, 1, 400, 1, (v) => { settings.envelope.period = v; applyIndicatorSettings(); }));
  const envSub1 = document.createElement("span"); envSub1.className = "sub"; envSub1.textContent = "기간";
  envRow.appendChild(envSub1);
  envRow.appendChild(numberInput(settings.envelope.percent, 0.1, 50, 0.1, (v) => { settings.envelope.percent = v; applyIndicatorSettings(); }));
  const envSub2 = document.createElement("span"); envSub2.className = "sub"; envSub2.textContent = "%";
  envRow.appendChild(envSub2);
  envSection.appendChild(envRow);
  panel.appendChild(envSection);

  // 볼린저밴드
  const bbSection = document.createElement("div");
  bbSection.className = "ind-section";
  const bbRow = document.createElement("div");
  bbRow.className = "ind-row";
  bbRow.appendChild(checkboxLabel("볼린저밴드", settings.bollinger.on, (v) => { settings.bollinger.on = v; applyIndicatorSettings(); }));
  bbRow.appendChild(numberInput(settings.bollinger.period, 1, 400, 1, (v) => { settings.bollinger.period = v; applyIndicatorSettings(); }));
  const bbSub1 = document.createElement("span"); bbSub1.className = "sub"; bbSub1.textContent = "기간";
  bbRow.appendChild(bbSub1);
  bbRow.appendChild(numberInput(settings.bollinger.mult, 0.5, 10, 0.1, (v) => { settings.bollinger.mult = v; applyIndicatorSettings(); }));
  const bbSub2 = document.createElement("span"); bbSub2.className = "sub"; bbSub2.textContent = "승수";
  bbRow.appendChild(bbSub2);
  bbSection.appendChild(bbRow);
  panel.appendChild(bbSection);

  // 거래량
  const volSection = document.createElement("div");
  volSection.className = "ind-section";
  const volRow = document.createElement("div");
  volRow.className = "ind-row";
  volRow.appendChild(checkboxLabel("거래량", settings.volume.on, (v) => { settings.volume.on = v; applyIndicatorSettings(); }));
  volSection.appendChild(volRow);
  panel.appendChild(volSection);

  // RSI
  const rsiSection = document.createElement("div");
  rsiSection.className = "ind-section";
  const rsiRow = document.createElement("div");
  rsiRow.className = "ind-row";
  rsiRow.appendChild(checkboxLabel("RSI", settings.rsi.on, (v) => { settings.rsi.on = v; applyIndicatorSettings(); }));
  rsiRow.appendChild(numberInput(settings.rsi.period, 2, 100, 1, (v) => { settings.rsi.period = v; applyIndicatorSettings(); }));
  const rsiSub = document.createElement("span"); rsiSub.className = "sub"; rsiSub.textContent = "기간";
  rsiRow.appendChild(rsiSub);
  rsiSection.appendChild(rsiRow);
  panel.appendChild(rsiSection);

  // MACD
  const macdSection = document.createElement("div");
  macdSection.className = "ind-section";
  const macdRow = document.createElement("div");
  macdRow.className = "ind-row";
  macdRow.appendChild(checkboxLabel("MACD", settings.macd.on, (v) => { settings.macd.on = v; applyIndicatorSettings(); }));
  macdRow.appendChild(numberInput(settings.macd.fast, 2, 100, 1, (v) => { settings.macd.fast = v; applyIndicatorSettings(); }));
  macdRow.appendChild(numberInput(settings.macd.slow, 2, 200, 1, (v) => { settings.macd.slow = v; applyIndicatorSettings(); }));
  macdRow.appendChild(numberInput(settings.macd.signal, 2, 100, 1, (v) => { settings.macd.signal = v; applyIndicatorSettings(); }));
  const macdSub = document.createElement("span"); macdSub.className = "sub"; macdSub.textContent = "단기·장기·시그널";
  macdRow.appendChild(macdSub);
  macdSection.appendChild(macdRow);
  panel.appendChild(macdSection);

  // 초기화
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ind-reset";
  reset.textContent = "기본값으로 초기화";
  reset.addEventListener("click", () => {
    settings = structuredClone(DEFAULT_SETTINGS);
    applyIndicatorSettings();
    buildIndicatorPanel();
  });
  panel.appendChild(reset);
}

els.indicatorBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = els.indicatorPanel.hidden;
  els.indicatorPanel.hidden = !open;
  els.indicatorBtn.classList.toggle("open", open);
  els.indicatorBtn.setAttribute("aria-expanded", String(open));
});
els.indicatorPanel.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => {
  if (!els.indicatorPanel.hidden) {
    els.indicatorPanel.hidden = true;
    els.indicatorBtn.classList.remove("open");
    els.indicatorBtn.setAttribute("aria-expanded", "false");
  }
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

/** 십자선 위치의 이동평균 값 표시용: param이 없으면 마지막 값 사용 */
function maLegendHtml(param) {
  const parts = [];
  settings.ma.forEach((m, i) => {
    const series = ind.ma[i];
    if (!series) return;
    let value;
    if (param) {
      value = param.seriesData.get(series)?.value;
    } else {
      const bars = state.bars;
      if (bars.length >= m.period) {
        const data = Indicators.ma(bars.slice(-m.period * 3 - 5), m.period, m.type);
        value = data[data.length - 1]?.value;
      }
    }
    if (value === undefined) return;
    parts.push(
      `<span class="ind-item"><span class="ind-dot" style="background:${MA_COLORS[i]}"></span>` +
      `${m.type === "EMA" ? "EMA" : "MA"}${m.period} ${fmt.format(value)}</span>`
    );
  });
  return parts.length ? `<span class="ind-values">${parts.join("")}</span>` : "";
}

function renderLegend(param) {
  if (state.bars.length === 0) { els.legend.textContent = ""; return; }
  const bar = param?.time != null ? param.seriesData.get(candleSeries) : null;
  const src = bar ?? candlePoint(state.bars[state.bars.length - 1]);
  const cls = src.close >= src.open ? "v-up" : "v-down";
  els.legend.innerHTML =
    `<b>${state.symbol}</b> · ${state.timeframe} &nbsp; ` +
    `시 <span class="${cls}">${fmt.format(src.open)}</span> ` +
    `고 <span class="${cls}">${fmt.format(src.high)}</span> ` +
    `저 <span class="${cls}">${fmt.format(src.low)}</span> ` +
    `종 <span class="${cls}">${fmt.format(src.close)}</span>` +
    maLegendHtml(bar ? param : null);
}

chart.subscribeCrosshairMove((param) => {
  renderLegend(param?.time != null ? param : null);
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
  buildIndicatorPanel();
  syncIndicatorSeries();
  await refreshMeta();
  await loadInitial();

  setInterval(pollLive, LIVE_POLL_MS);
  setInterval(refreshMeta, META_POLL_MS);
}

init().catch((e) => {
  els.statusDot.className = "dot dot-error";
  els.statusText.textContent = `초기화 실패: ${e.message}`;
});
