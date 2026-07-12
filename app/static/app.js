/* cmmAuto 차트 뷰어 프론트엔드 — 멀티 차트 (최대 4분할, 트레이딩뷰 스타일)
 *
 * - 툴바의 분할 버튼(1/2/3/4)으로 화면을 나누고, 경계선을 드래그해 프레임 크기 조절
 * - 각 패널은 거래소/심볼/봉을 독립 선택하고, 자체적으로 과거 로드·실시간 갱신
 * - 지표(이동평균선·Envelope·볼린저·거래량·RSI·MACD)는 패널마다 독립 설정
 * - 분할 상태·크기·패널별 선택·패널별 지표 설정은 localStorage에 저장되어 유지
 */

const LIVE_POLL_MS = 5000;
const META_POLL_MS = 15000;
const PAGE_SIZE = 600;
const MAX_PANELS = 4;
const GUTTER = 6;         // 프레임 경계선 두께(px)
const SPLIT_MIN = 0.15;   // 드래그로 줄일 수 있는 최소 비율

// 검증된 상승/하락 색 (다크 표면 #131722 기준 대비·CVD 분리 PASS)
const UP = "#26a69a";
const DOWN = "#ef5350";
// 이동평균선 슬롯별 고정 색 (다크 표면 기준 검증 통과 팔레트 — 순서 고정, 순환 금지)
const MA_COLORS = ["#d97706", "#3b82f6", "#db2777", "#8b5cf6"];
const BAND_COLOR = "#7c8aa0"; // Envelope/볼린저 밴드용 중립 회청색

const PRICE_SCALE_WIDTH = 84; // 패널 내 상하 정렬을 위해 모든 차트의 가격축 폭 통일

let meta = null; // /api/meta 응답 (전 패널 공유)

/* ---------- 공용 유틸 ---------- */

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

/** 지표 워밍업 구간을 whitespace 포인트로 채워 메인 차트와 논리 인덱스를 1:1로 맞춘다 */
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

const lineDefaults = {
  lineWidth: 1,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
};

/* ---------- 지표 설정 (패널별 독립) ---------- */

const LEGACY_SETTINGS_KEY = "cmmauto.indicators.v1"; // 구버전(전역 지표) 마이그레이션용

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

/** 저장된 지표 설정을 기본값 위에 얹어 완전한 설정 객체를 만든다 */
function mergeIndicatorSettings(saved) {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!saved) return base;
  try {
    for (let i = 0; i < base.ma.length; i++) Object.assign(base.ma[i], saved.ma?.[i]);
    Object.assign(base.envelope, saved.envelope);
    Object.assign(base.bollinger, saved.bollinger);
    Object.assign(base.volume, saved.volume);
    Object.assign(base.rsi, saved.rsi);
    Object.assign(base.macd, saved.macd);
  } catch { /* 손상된 저장값은 기본값으로 */ }
  return base;
}

function legacyGlobalSettings() {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_SETTINGS_KEY));
  } catch {
    return null;
  }
}

/* ---------- 개별 차트 패널 ---------- */

class ChartPanel {
  /** @param sel {exchange, symbol, timeframe, indicators?} */
  constructor(container, sel) {
    this.sel = { exchange: sel.exchange, symbol: sel.symbol, timeframe: sel.timeframe };
    // 패널별 지표 설정: 저장값 → 구버전 전역 설정 → 기본값 순으로 복원
    this.settings = mergeIndicatorSettings(sel.indicators ?? legacyGlobalSettings());
    this.bars = [];
    this.loadingOlder = false;
    this.hasMoreHistory = true;
    this.loadToken = 0;
    this.fmt = numFmt(2);
    this.destroyed = false;

    this.root = document.createElement("section");
    this.root.className = "panel";
    this.buildDom();
    container.appendChild(this.root);
    this.createCharts();
    this.renderToolbar();
    this.buildIndicatorPopover();
    this.syncIndicatorSeries();
    this.loadInitial();
  }

  buildDom() {
    this.root.innerHTML = `
      <header class="panel-bar">
        <select class="sel-exchange" aria-label="거래소"></select>
        <select class="sel-symbol" aria-label="심볼"></select>
        <div class="segmented tf-group" role="group" aria-label="타임프레임"></div>
        <div class="field indicator-field">
          <button type="button" class="indicator-btn" aria-expanded="false">지표 ▾</button>
          <div class="indicator-panel" hidden></div>
        </div>
        <div class="panel-price" hidden>
          <span class="last">–</span>
          <span class="chg">–</span>
        </div>
      </header>
      <div class="panel-body">
        <div class="pane pane-main">
          <div class="legend"></div>
          <div class="pane-chart chart-main"></div>
          <div class="empty-hint" hidden>아직 수집된 캔들이 없습니다. 수집기가 데이터를 채우는 중이면 잠시 후 자동으로 표시됩니다.</div>
        </div>
        <div class="pane pane-sub pane-rsi" hidden>
          <div class="pane-label label-rsi">RSI</div>
          <div class="pane-chart chart-rsi"></div>
        </div>
        <div class="pane pane-sub pane-macd" hidden>
          <div class="pane-label label-macd">MACD</div>
          <div class="pane-chart chart-macd"></div>
        </div>
      </div>`;
    const $ = (cls) => this.root.querySelector("." + cls);
    this.els = {
      exchange: $("sel-exchange"),
      symbol: $("sel-symbol"),
      tfGroup: $("tf-group"),
      indBtn: $("indicator-btn"),
      indPanel: $("indicator-panel"),
      price: $("panel-price"),
      last: $("last"),
      chg: $("chg"),
      legend: $("legend"),
      emptyHint: $("empty-hint"),
      paneMain: $("pane-main"),
      paneRsi: $("pane-rsi"),
      paneMacd: $("pane-macd"),
      labelRsi: $("label-rsi"),
      labelMacd: $("label-macd"),
      chartMain: $("chart-main"),
      chartRsi: $("chart-rsi"),
      chartMacd: $("chart-macd"),
    };

    this.els.exchange.addEventListener("change", () => {
      this.sel.exchange = this.els.exchange.value;
      this.sel.symbol = this.exchangeMeta()?.symbols?.[0] ?? null;
      this.sel.timeframe = this.firstSupportedTimeframe();
      this.renderToolbar();
      saveLayout();
      this.loadInitial();
    });
    this.els.symbol.addEventListener("change", () => {
      this.sel.symbol = this.els.symbol.value;
      saveLayout();
      this.loadInitial();
    });

    this.els.indBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = this.els.indPanel.hidden;
      closeAllIndicatorPopovers();
      this.els.indPanel.hidden = !open;
      this.els.indBtn.classList.toggle("open", open);
      this.els.indBtn.setAttribute("aria-expanded", String(open));
    });
    this.els.indPanel.addEventListener("click", (e) => e.stopPropagation());
  }

  closeIndicatorPopover() {
    this.els.indPanel.hidden = true;
    this.els.indBtn.classList.remove("open");
    this.els.indBtn.setAttribute("aria-expanded", "false");
  }

  createCharts() {
    this.chart = LightweightCharts.createChart(this.els.chartMain, baseChartOptions());
    // 서브 패널은 메인 차트의 시간 범위를 따라가는 수동 디스플레이 (직접 스크롤/줌 불가)
    const subOptions = () => ({
      ...baseChartOptions(),
      timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, visible: false },
      handleScroll: false,
      handleScale: false,
    });
    this.rsiChart = LightweightCharts.createChart(this.els.chartRsi, subOptions());
    this.macdChart = LightweightCharts.createChart(this.els.chartMacd, subOptions());

    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
      borderVisible: false,
    });
    this.volumeSeries = this.chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    // 지표 시리즈 슬롯
    this.ind = {
      ma: [null, null, null, null],
      envUpper: null, envLower: null,
      bbUpper: null, bbMiddle: null, bbLower: null,
      rsi: null,
      macdLine: null, macdSignal: null, macdHist: null,
    };

    this.resizeObservers = [];
    for (const [paneEl, chartObj] of [
      [this.els.paneMain, this.chart],
      [this.els.paneRsi, this.rsiChart],
      [this.els.paneMacd, this.macdChart],
    ]) {
      const ro = new ResizeObserver(() => chartObj.resize(paneEl.clientWidth, paneEl.clientHeight));
      ro.observe(paneEl);
      this.resizeObservers.push(ro);
    }

    // 시간축 동기화: 메인 → 서브 단방향
    // (range 이벤트가 비동기라 양방향은 setData 시 초기 범위가 역전파된다)
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      this.rsiChart.timeScale().setVisibleLogicalRange(range);
      this.macdChart.timeScale().setVisibleLogicalRange(range);
      if (range.from < 15) this.loadOlder();
    });

    this.chart.subscribeCrosshairMove((param) => {
      this.renderLegend(param?.time != null ? param : null);
    });
  }

  destroy() {
    this.destroyed = true;
    this.loadToken++;
    for (const ro of this.resizeObservers) ro.disconnect();
    this.chart.remove();
    this.rsiChart.remove();
    this.macdChart.remove();
    this.root.remove();
  }

  /* ----- 툴바 ----- */

  exchangeMeta() {
    return meta?.exchanges?.[this.sel.exchange];
  }

  firstSupportedTimeframe() {
    const supported = new Set(this.exchangeMeta()?.status?.timeframes ?? meta.timeframes);
    if (supported.has(this.sel.timeframe)) return this.sel.timeframe;
    return meta.timeframes.find((tf) => supported.has(tf)) ?? meta.timeframes[0];
  }

  renderToolbar() {
    const { exchange, symbol } = this.els;
    exchange.innerHTML = "";
    for (const exId of Object.keys(meta.exchanges)) {
      const opt = document.createElement("option");
      opt.value = exId;
      opt.textContent = exId;
      exchange.appendChild(opt);
    }
    exchange.value = this.sel.exchange;

    symbol.innerHTML = "";
    for (const sym of this.exchangeMeta()?.symbols ?? []) {
      const opt = document.createElement("option");
      opt.value = sym;
      opt.textContent = sym;
      symbol.appendChild(opt);
    }
    symbol.value = this.sel.symbol;

    this.renderTimeframes();
  }

  renderTimeframes() {
    this.els.tfGroup.innerHTML = "";
    const supported = new Set(this.exchangeMeta()?.status?.timeframes ?? meta.timeframes);
    for (const tf of meta.timeframes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = tf;
      btn.disabled = !supported.has(tf);
      btn.classList.toggle("active", tf === this.sel.timeframe);
      btn.addEventListener("click", () => {
        this.sel.timeframe = tf;
        this.renderTimeframes();
        saveLayout();
        this.loadInitial();
      });
      this.els.tfGroup.appendChild(btn);
    }
  }

  /* ----- 데이터 로드 ----- */

  candlesUrl(extra = "") {
    const { exchange, symbol, timeframe } = this.sel;
    return `/api/candles?exchange=${encodeURIComponent(exchange)}&symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}${extra}`;
  }

  async loadInitial() {
    const token = ++this.loadToken;
    this.bars = [];
    this.hasMoreHistory = true;
    this.candleSeries.setData([]);
    this.volumeSeries.setData([]);
    this.recomputeIndicators();
    this.els.price.hidden = true;
    this.els.legend.textContent = "";

    const data = await api(this.candlesUrl(`&limit=${PAGE_SIZE}`));
    if (token !== this.loadToken || this.destroyed) return;

    this.bars = data.candles;
    this.hasMoreHistory = data.candles.length >= PAGE_SIZE;
    this.els.emptyHint.hidden = this.bars.length > 0;

    const precision = inferPrecision(this.bars);
    this.fmt = numFmt(precision);
    this.candleSeries.applyOptions({
      priceFormat: { type: "price", precision, minMove: precision ? Math.pow(10, -precision) : 1 },
    });

    this.candleSeries.setData(this.bars.map(candlePoint));
    this.volumeSeries.setData(this.bars.map(volumePoint));
    this.recomputeIndicators();
    // 최근 150봉만 보이게 시작 (전체를 펼치면 왼쪽 끝에 닿아 과거 로드가 연쇄됨)
    this.chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, this.bars.length - 150),
      to: this.bars.length + 5,
    });
    this.updatePriceBox();
    this.renderLegend(null);
  }

  async loadOlder() {
    if (this.loadingOlder || !this.hasMoreHistory || this.bars.length === 0) return;
    this.loadingOlder = true;
    const token = this.loadToken;
    try {
      const oldest = this.bars[0].time;
      const data = await api(this.candlesUrl(`&limit=${PAGE_SIZE}&before=${oldest}`));
      if (token !== this.loadToken || this.destroyed) return;
      if (data.candles.length === 0) {
        this.hasMoreHistory = false;
        return;
      }
      this.bars = data.candles.concat(this.bars);
      this.hasMoreHistory = data.candles.length >= PAGE_SIZE;
      this.candleSeries.setData(this.bars.map(candlePoint));
      this.volumeSeries.setData(this.bars.map(volumePoint));
      this.recomputeIndicators();
    } finally {
      this.loadingOlder = false;
    }
  }

  async pollLive() {
    if (this.destroyed || this.bars.length === 0) return;
    const token = this.loadToken;
    try {
      const data = await api(this.candlesUrl("&limit=3"));
      if (token !== this.loadToken || this.destroyed || data.candles.length === 0) return;
      const lastKnown = this.bars[this.bars.length - 1].time;
      let changed = false;
      for (const b of data.candles) {
        if (b.time < lastKnown) continue;
        if (b.time === lastKnown) {
          this.bars[this.bars.length - 1] = b;
        } else {
          this.bars.push(b);
        }
        this.candleSeries.update(candlePoint(b));
        this.volumeSeries.update(volumePoint(b));
        changed = true;
      }
      if (changed) this.recomputeIndicators();
      this.els.emptyHint.hidden = true;
      this.updatePriceBox();
    } catch {
      /* 일시적 네트워크 오류는 다음 폴링에서 회복 */
    }
  }

  /* ----- 지표 ----- */

  addLine(target, color, extra = {}) {
    return target.addLineSeries({ ...lineDefaults, color, ...extra });
  }

  removeInd(target, key) {
    if (this.ind[key]) {
      target.removeSeries(this.ind[key]);
      this.ind[key] = null;
    }
  }

  /** 이 패널의 지표 설정에 맞게 시리즈를 만들거나 제거한다 */
  syncIndicatorSeries() {
    const ind = this.ind;
    const settings = this.settings;

    settings.ma.forEach((m, i) => {
      if (m.on && !ind.ma[i]) ind.ma[i] = this.addLine(this.chart, MA_COLORS[i], { lineWidth: 2 });
      if (!m.on && ind.ma[i]) { this.chart.removeSeries(ind.ma[i]); ind.ma[i] = null; }
    });

    if (settings.envelope.on) {
      if (!ind.envUpper) ind.envUpper = this.addLine(this.chart, BAND_COLOR, { lineStyle: LightweightCharts.LineStyle.Dashed });
      if (!ind.envLower) ind.envLower = this.addLine(this.chart, BAND_COLOR, { lineStyle: LightweightCharts.LineStyle.Dashed });
    } else {
      this.removeInd(this.chart, "envUpper");
      this.removeInd(this.chart, "envLower");
    }

    if (settings.bollinger.on) {
      if (!ind.bbUpper) ind.bbUpper = this.addLine(this.chart, BAND_COLOR, { lineStyle: LightweightCharts.LineStyle.Dotted });
      if (!ind.bbMiddle) ind.bbMiddle = this.addLine(this.chart, BAND_COLOR);
      if (!ind.bbLower) ind.bbLower = this.addLine(this.chart, BAND_COLOR, { lineStyle: LightweightCharts.LineStyle.Dotted });
    } else {
      this.removeInd(this.chart, "bbUpper");
      this.removeInd(this.chart, "bbMiddle");
      this.removeInd(this.chart, "bbLower");
    }

    this.volumeSeries.applyOptions({ visible: settings.volume.on });

    this.els.paneRsi.hidden = !settings.rsi.on;
    if (settings.rsi.on) {
      if (!ind.rsi) {
        ind.rsi = this.addLine(this.rsiChart, "#8b5cf6", { lineWidth: 2, lastValueVisible: true });
        ind.rsi.createPriceLine({ price: 70, color: "#4c525e", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false });
        ind.rsi.createPriceLine({ price: 30, color: "#4c525e", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false });
      }
      this.els.labelRsi.textContent = `RSI ${settings.rsi.period}`;
    } else {
      this.removeInd(this.rsiChart, "rsi");
    }

    this.els.paneMacd.hidden = !settings.macd.on;
    if (settings.macd.on) {
      if (!ind.macdHist) {
        ind.macdHist = this.macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        ind.macdLine = this.addLine(this.macdChart, "#3b82f6", { lineWidth: 2, lastValueVisible: true });
        ind.macdSignal = this.addLine(this.macdChart, "#d97706", { lineWidth: 1 });
      }
      this.els.labelMacd.textContent = `MACD ${settings.macd.fast},${settings.macd.slow},${settings.macd.signal}`;
    } else {
      this.removeInd(this.macdChart, "macdHist");
      this.removeInd(this.macdChart, "macdLine");
      this.removeInd(this.macdChart, "macdSignal");
    }

    // 시간축은 가장 아래에 보이는 패널에만 표시
    const lowest = settings.macd.on ? "macd" : settings.rsi.on ? "rsi" : "main";
    this.chart.timeScale().applyOptions({ visible: lowest === "main" });
    this.rsiChart.timeScale().applyOptions({ visible: lowest === "rsi" });
    this.macdChart.timeScale().applyOptions({ visible: lowest === "macd" });
  }

  pushRangeToSubs() {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    if (!r) return;
    this.rsiChart.timeScale().setVisibleLogicalRange(r);
    this.macdChart.timeScale().setVisibleLogicalRange(r);
  }

  /** 현재 캔들로 활성 지표를 전부 다시 계산해 시리즈에 반영한다 */
  recomputeIndicators() {
    try {
      this.recomputeIndicatorsInner();
    } finally {
      // 첫 setData 시 서브 차트의 "전체 보기" 초기화가 비동기로 늦게 적용될 수
      // 있어, 즉시 + 다음 프레임에 한 번 더 메인 범위를 맞춘다.
      this.pushRangeToSubs();
      requestAnimationFrame(() => { if (!this.destroyed) this.pushRangeToSubs(); });
    }
  }

  recomputeIndicatorsInner() {
    const bars = this.bars;
    const ind = this.ind;
    const settings = this.settings;
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

  applySettingsChange() {
    saveLayout();
    this.syncIndicatorSeries();
    this.recomputeIndicators();
    this.renderLegend(null);
  }

  /* ----- 지표 설정 팝오버 (패널별) ----- */

  buildIndicatorPopover() {
    const panel = this.els.indPanel;
    const settings = this.settings;
    const apply = () => this.applySettingsChange();
    panel.innerHTML = "";

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
      row.appendChild(checkboxLabel("", m.on, (v) => { m.on = v; apply(); }));
      const typeSel = document.createElement("select");
      for (const t of ["SMA", "EMA"]) {
        const o = document.createElement("option");
        o.value = t; o.textContent = t;
        typeSel.appendChild(o);
      }
      typeSel.value = m.type;
      typeSel.addEventListener("change", () => { m.type = typeSel.value; apply(); });
      row.appendChild(typeSel);
      row.appendChild(numberInput(m.period, 1, 400, 1, (v) => { m.period = v; apply(); }));
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = "기간";
      row.appendChild(sub);
      maSection.appendChild(row);
    });
    panel.appendChild(maSection);

    const envSection = document.createElement("div");
    envSection.className = "ind-section";
    const envRow = document.createElement("div");
    envRow.className = "ind-row";
    envRow.appendChild(checkboxLabel("Envelope", settings.envelope.on, (v) => { settings.envelope.on = v; apply(); }));
    envRow.appendChild(numberInput(settings.envelope.period, 1, 400, 1, (v) => { settings.envelope.period = v; apply(); }));
    const envSub1 = document.createElement("span"); envSub1.className = "sub"; envSub1.textContent = "기간";
    envRow.appendChild(envSub1);
    envRow.appendChild(numberInput(settings.envelope.percent, 0.1, 50, 0.1, (v) => { settings.envelope.percent = v; apply(); }));
    const envSub2 = document.createElement("span"); envSub2.className = "sub"; envSub2.textContent = "%";
    envRow.appendChild(envSub2);
    envSection.appendChild(envRow);
    panel.appendChild(envSection);

    const bbSection = document.createElement("div");
    bbSection.className = "ind-section";
    const bbRow = document.createElement("div");
    bbRow.className = "ind-row";
    bbRow.appendChild(checkboxLabel("볼린저밴드", settings.bollinger.on, (v) => { settings.bollinger.on = v; apply(); }));
    bbRow.appendChild(numberInput(settings.bollinger.period, 1, 400, 1, (v) => { settings.bollinger.period = v; apply(); }));
    const bbSub1 = document.createElement("span"); bbSub1.className = "sub"; bbSub1.textContent = "기간";
    bbRow.appendChild(bbSub1);
    bbRow.appendChild(numberInput(settings.bollinger.mult, 0.5, 10, 0.1, (v) => { settings.bollinger.mult = v; apply(); }));
    const bbSub2 = document.createElement("span"); bbSub2.className = "sub"; bbSub2.textContent = "승수";
    bbRow.appendChild(bbSub2);
    bbSection.appendChild(bbRow);
    panel.appendChild(bbSection);

    const volSection = document.createElement("div");
    volSection.className = "ind-section";
    const volRow = document.createElement("div");
    volRow.className = "ind-row";
    volRow.appendChild(checkboxLabel("거래량", settings.volume.on, (v) => { settings.volume.on = v; apply(); }));
    volSection.appendChild(volRow);
    panel.appendChild(volSection);

    const rsiSection = document.createElement("div");
    rsiSection.className = "ind-section";
    const rsiRow = document.createElement("div");
    rsiRow.className = "ind-row";
    rsiRow.appendChild(checkboxLabel("RSI", settings.rsi.on, (v) => { settings.rsi.on = v; apply(); }));
    rsiRow.appendChild(numberInput(settings.rsi.period, 2, 100, 1, (v) => { settings.rsi.period = v; apply(); }));
    const rsiSub = document.createElement("span"); rsiSub.className = "sub"; rsiSub.textContent = "기간";
    rsiRow.appendChild(rsiSub);
    rsiSection.appendChild(rsiRow);
    panel.appendChild(rsiSection);

    const macdSection = document.createElement("div");
    macdSection.className = "ind-section";
    const macdRow = document.createElement("div");
    macdRow.className = "ind-row";
    macdRow.appendChild(checkboxLabel("MACD", settings.macd.on, (v) => { settings.macd.on = v; apply(); }));
    macdRow.appendChild(numberInput(settings.macd.fast, 2, 100, 1, (v) => { settings.macd.fast = v; apply(); }));
    macdRow.appendChild(numberInput(settings.macd.slow, 2, 200, 1, (v) => { settings.macd.slow = v; apply(); }));
    macdRow.appendChild(numberInput(settings.macd.signal, 2, 100, 1, (v) => { settings.macd.signal = v; apply(); }));
    const macdSub = document.createElement("span"); macdSub.className = "sub"; macdSub.textContent = "단기·장기·시그널";
    macdRow.appendChild(macdSub);
    macdSection.appendChild(macdRow);
    panel.appendChild(macdSection);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "ind-reset";
    reset.textContent = "기본값으로 초기화";
    reset.addEventListener("click", () => {
      this.settings = structuredClone(DEFAULT_SETTINGS);
      this.applySettingsChange();
      this.buildIndicatorPopover();
    });
    panel.appendChild(reset);
  }

  /* ----- 표시 ----- */

  updatePriceBox() {
    if (this.bars.length === 0) return;
    const last = this.bars[this.bars.length - 1];
    const prev = this.bars.length > 1 ? this.bars[this.bars.length - 2] : last;
    const diff = last.close - prev.close;
    const pct = prev.close ? (diff / prev.close) * 100 : 0;
    this.els.price.hidden = false;
    this.els.last.textContent = this.fmt.format(last.close);
    this.els.chg.textContent = `${this.fmt.format(Math.abs(diff))} (${Math.abs(pct).toFixed(2)}%)`;
    this.els.chg.className = `chg ${diff >= 0 ? "up" : "down"}`;
  }

  maLegendHtml(param) {
    const parts = [];
    this.settings.ma.forEach((m, i) => {
      const series = this.ind.ma[i];
      if (!series) return;
      let value;
      if (param) {
        value = param.seriesData.get(series)?.value;
      } else if (this.bars.length >= m.period) {
        const data = Indicators.ma(this.bars.slice(-m.period * 3 - 5), m.period, m.type);
        value = data[data.length - 1]?.value;
      }
      if (value === undefined) return;
      parts.push(
        `<span class="ind-item"><span class="ind-dot" style="background:${MA_COLORS[i]}"></span>` +
        `${m.type === "EMA" ? "EMA" : "MA"}${m.period} ${this.fmt.format(value)}</span>`
      );
    });
    return parts.length ? `<span class="ind-values">${parts.join("")}</span>` : "";
  }

  renderLegend(param) {
    if (this.bars.length === 0) { this.els.legend.textContent = ""; return; }
    const bar = param?.time != null ? param.seriesData.get(this.candleSeries) : null;
    const src = bar ?? candlePoint(this.bars[this.bars.length - 1]);
    const cls = src.close >= src.open ? "v-up" : "v-down";
    this.els.legend.innerHTML =
      `<b>${this.sel.symbol}</b> · ${this.sel.timeframe} &nbsp; ` +
      `시 <span class="${cls}">${this.fmt.format(src.open)}</span> ` +
      `고 <span class="${cls}">${this.fmt.format(src.high)}</span> ` +
      `저 <span class="${cls}">${this.fmt.format(src.low)}</span> ` +
      `종 <span class="${cls}">${this.fmt.format(src.close)}</span>` +
      this.maLegendHtml(bar ? param : null);
  }
}

/* ---------- 지표 팝오버 공용 위젯 ---------- */

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

function closeAllIndicatorPopovers() {
  for (const p of panels) p.closeIndicatorPopover();
}

document.addEventListener("click", () => closeAllIndicatorPopovers());

/* ---------- 레이아웃 관리 (분할 + 드래그 리사이즈) ---------- */

const LAYOUT_KEY = "cmmauto.layout.v2";
const LEGACY_LAYOUT_KEY = "cmmauto.layout.v1";
const gridEl = document.getElementById("grid");
const panels = [];
let layoutCount = 1;
// 경계선 위치 (0~1 비율). col: 좌/우 분할, row: 상/하 분할
let splits = { col: 0.5, row: 0.5 };

function defaultSelection(i) {
  const exId = Object.keys(meta.exchanges)[0];
  const symbols = meta.exchanges[exId]?.symbols ?? [];
  return {
    exchange: exId,
    symbol: symbols[i % Math.max(1, symbols.length)] ?? symbols[0] ?? null,
    timeframe: meta.timeframes.includes("1h") ? "1h" : meta.timeframes[0],
  };
}

function currentLayoutState() {
  return {
    layout: layoutCount,
    splits,
    panels: panels.map((p) => ({ ...p.sel, indicators: p.settings })),
  };
}

function saveLayout() {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(currentLayoutState()));
}

/** 저장된 프리셋을 화면에 적용한다 (전 패널 재구성) */
function applyLayoutState(state) {
  while (panels.length) panels.pop().destroy();
  splits = {
    col: state?.splits?.col ?? 0.5,
    row: state?.splits?.row ?? 0.5,
  };
  const n = Math.min(MAX_PANELS, Math.max(1, state?.layout ?? 1));
  setLayout(n, state?.panels ?? []);
}

function loadLayoutPref() {
  try {
    const v2 = JSON.parse(localStorage.getItem(LAYOUT_KEY));
    if (v2) return v2;
  } catch { /* fallthrough */ }
  try {
    // 구버전 마이그레이션: 패널 선택은 유지, 지표는 당시 전역 설정을 각 패널에 적용
    const v1 = JSON.parse(localStorage.getItem(LEGACY_LAYOUT_KEY));
    if (v1) return { layout: v1.layout, splits: null, panels: v1.panels ?? [] };
  } catch { /* fallthrough */ }
  return null;
}

function validSelection(sel) {
  if (!sel || !meta.exchanges[sel.exchange]) return null;
  const exMeta = meta.exchanges[sel.exchange];
  return {
    exchange: sel.exchange,
    symbol: exMeta.symbols.includes(sel.symbol) ? sel.symbol : exMeta.symbols[0],
    timeframe: meta.timeframes.includes(sel.timeframe) ? sel.timeframe : meta.timeframes[0],
    indicators: sel.indicators ?? null,
  };
}

/** 현재 splits 값으로 grid-template을 갱신한다 (드래그 중에도 호출됨) */
function applyGridTemplate() {
  const c = Math.min(1 - SPLIT_MIN, Math.max(SPLIT_MIN, splits.col));
  const r = Math.min(1 - SPLIT_MIN, Math.max(SPLIT_MIN, splits.row));
  if (layoutCount === 1) {
    gridEl.style.gridTemplateColumns = "1fr";
    gridEl.style.gridTemplateRows = "1fr";
  } else if (layoutCount === 2) {
    gridEl.style.gridTemplateColumns = `${c}fr ${GUTTER}px ${1 - c}fr`;
    gridEl.style.gridTemplateRows = "1fr";
  } else {
    gridEl.style.gridTemplateColumns = `${c}fr ${GUTTER}px ${1 - c}fr`;
    gridEl.style.gridTemplateRows = `${r}fr ${GUTTER}px ${1 - r}fr`;
  }
}

function makeGutter(direction) {
  const g = document.createElement("div");
  g.className = `gutter gutter-${direction}`;
  g.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add("dragging");
    const rect = gridEl.getBoundingClientRect();
    const onMove = (ev) => {
      if (direction === "v") {
        splits.col = (ev.clientX - rect.left) / rect.width;
      } else {
        splits.row = (ev.clientY - rect.top) / rect.height;
      }
      splits.col = Math.min(1 - SPLIT_MIN, Math.max(SPLIT_MIN, splits.col));
      splits.row = Math.min(1 - SPLIT_MIN, Math.max(SPLIT_MIN, splits.row));
      applyGridTemplate();
    };
    const onUp = () => {
      g.classList.remove("dragging");
      g.removeEventListener("pointermove", onMove);
      g.removeEventListener("pointerup", onUp);
      saveLayout();
    };
    g.addEventListener("pointermove", onMove);
    g.addEventListener("pointerup", onUp);
  });
  return g;
}

/** 패널·경계선을 grid 셀에 배치한다 */
function placePanels() {
  // 기존 경계선 제거
  for (const g of gridEl.querySelectorAll(".gutter")) g.remove();

  const place = (el, row, col) => {
    el.style.gridRow = row;
    el.style.gridColumn = col;
  };

  if (layoutCount === 1) {
    place(panels[0].root, "1", "1");
  } else if (layoutCount === 2) {
    place(panels[0].root, "1", "1");
    place(panels[1].root, "1", "3");
    const gv = makeGutter("v");
    place(gv, "1", "2");
    gridEl.appendChild(gv);
  } else if (layoutCount === 3) {
    // 좌 1개(세로 전체) + 우 2개(상하)
    place(panels[0].root, "1 / -1", "1");
    place(panels[1].root, "1", "3");
    place(panels[2].root, "3", "3");
    const gv = makeGutter("v");
    place(gv, "1 / -1", "2");
    gridEl.appendChild(gv);
    const gh = makeGutter("h");
    place(gh, "2", "3");
    gridEl.appendChild(gh);
  } else {
    // 2×2
    place(panels[0].root, "1", "1");
    place(panels[1].root, "1", "3");
    place(panels[2].root, "3", "1");
    place(panels[3].root, "3", "3");
    const gv = makeGutter("v");
    place(gv, "1 / -1", "2");
    gridEl.appendChild(gv);
    const gh = makeGutter("h");
    place(gh, "2", "1 / -1");
    gridEl.appendChild(gh);
  }
  applyGridTemplate();
}

function setLayout(n, savedSelections = []) {
  layoutCount = n;
  gridEl.dataset.layout = String(n);
  while (panels.length > n) {
    panels.pop().destroy();
  }
  while (panels.length < n) {
    const i = panels.length;
    const sel = validSelection(savedSelections[i]) ?? defaultSelection(i);
    panels.push(new ChartPanel(gridEl, sel));
  }
  placePanels();
  for (const btn of document.querySelectorAll("#layout-group button")) {
    btn.classList.toggle("active", Number(btn.dataset.layout) === n);
  }
  saveLayout();
}

document.getElementById("layout-group").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-layout]");
  if (!btn) return;
  setLayout(Number(btn.dataset.layout));
});

/* ---------- 레이아웃 프리셋 저장/불러오기 (서버 DB에 저장) ---------- */

const layBtn = document.getElementById("layoutmgr-btn");
const layPanel = document.getElementById("layoutmgr-panel");

function closeLayoutPopover() {
  layPanel.hidden = true;
  layBtn.classList.remove("open");
  layBtn.setAttribute("aria-expanded", "false");
}

function layMessage(text, isError = false) {
  const msg = layPanel.querySelector(".lay-msg");
  if (msg) {
    msg.textContent = text;
    msg.className = `lay-msg${isError ? " err" : ""}`;
  }
}

async function buildLayoutPopover() {
  layPanel.innerHTML = "";

  const listSection = document.createElement("div");
  listSection.className = "ind-section";
  listSection.innerHTML = `<div class="ind-title">저장된 레이아웃</div>`;

  let layouts = [];
  try {
    layouts = (await api("/api/layouts")).layouts;
  } catch {
    listSection.innerHTML += `<div class="lay-empty">목록을 불러오지 못했습니다</div>`;
  }

  if (layouts.length === 0 && !listSection.querySelector(".lay-empty")) {
    listSection.innerHTML += `<div class="lay-empty">저장된 레이아웃이 없습니다</div>`;
  }

  const dateFmt = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  for (const item of layouts) {
    const row = document.createElement("div");
    row.className = "lay-row";

    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "lay-name";
    nameBtn.textContent = item.name;
    nameBtn.title = `"${item.name}" 불러오기`;
    nameBtn.addEventListener("click", async () => {
      try {
        const res = await api(`/api/layouts/${encodeURIComponent(item.name)}`);
        applyLayoutState(res.data);
        closeLayoutPopover();
      } catch (e) {
        layMessage(`불러오기 실패: ${e.message}`, true);
      }
    });
    row.appendChild(nameBtn);

    const date = document.createElement("span");
    date.className = "lay-date";
    date.textContent = dateFmt.format(new Date(item.updated_at * 1000));
    row.appendChild(date);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "lay-del";
    del.textContent = "✕";
    del.title = `"${item.name}" 삭제`;
    del.addEventListener("click", async () => {
      if (!confirm(`레이아웃 "${item.name}"을(를) 삭제할까요?`)) return;
      try {
        await fetch(`/api/layouts/${encodeURIComponent(item.name)}`, { method: "DELETE" });
        buildLayoutPopover();
      } catch (e) {
        layMessage(`삭제 실패: ${e.message}`, true);
      }
    });
    row.appendChild(del);

    listSection.appendChild(row);
  }
  layPanel.appendChild(listSection);

  const saveSection = document.createElement("div");
  saveSection.className = "ind-section";
  saveSection.innerHTML = `<div class="ind-title">현재 화면 저장</div>`;
  const saveRow = document.createElement("div");
  saveRow.className = "lay-save-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "레이아웃 이름";
  nameInput.maxLength = 60;
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "lay-save-btn";
  saveBtn.textContent = "저장";
  const doSave = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      layMessage("이름을 입력해 주세요", true);
      nameInput.focus();
      return;
    }
    const exists = layouts.some((l) => l.name === name);
    if (exists && !confirm(`"${name}"이(가) 이미 있습니다. 덮어쓸까요?`)) return;
    try {
      const res = await fetch(`/api/layouts/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentLayoutState()),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await buildLayoutPopover();
      layMessage(`"${name}" 저장됨`);
    } catch (e) {
      layMessage(`저장 실패: ${e.message}`, true);
    }
  };
  saveBtn.addEventListener("click", doSave);
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
  saveRow.appendChild(nameInput);
  saveRow.appendChild(saveBtn);
  saveSection.appendChild(saveRow);
  const msg = document.createElement("div");
  msg.className = "lay-msg";
  saveSection.appendChild(msg);
  layPanel.appendChild(saveSection);
}

layBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = layPanel.hidden;
  closeAllIndicatorPopovers();
  closeLayoutPopover();
  if (open) {
    layPanel.hidden = false;
    layBtn.classList.add("open");
    layBtn.setAttribute("aria-expanded", "true");
    buildLayoutPopover();
  }
});
layPanel.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => closeLayoutPopover());

/* ---------- 수집기 상태 표시 ---------- */

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

async function refreshMeta() {
  try {
    meta = await api("/api/meta");
  } catch {
    statusDot.className = "dot dot-error";
    statusText.textContent = "서버 연결 끊김";
    return;
  }
  let error = null;
  let lastSync = null;
  for (const [exId, ex] of Object.entries(meta.exchanges)) {
    const st = ex.status ?? {};
    if (st.last_error && !error) error = `${exId}: ${st.last_error}`;
    if (st.last_sync) lastSync = Math.max(lastSync ?? 0, st.last_sync);
  }
  if (error) {
    statusDot.className = "dot dot-error";
    statusText.textContent = `수집 오류 — ${error}`.slice(0, 90);
  } else if (lastSync) {
    const ago = Math.max(0, meta.server_time - lastSync);
    statusDot.className = "dot dot-ok";
    statusText.textContent = `동기화 ${ago}s 전`;
  } else {
    statusDot.className = "dot dot-unknown";
    statusText.textContent = "첫 수집 진행 중…";
  }
}

/* ---------- 부트스트랩 ---------- */

async function init() {
  meta = await api("/api/meta");

  const saved = loadLayoutPref();
  if (saved?.splits) splits = { col: saved.splits.col ?? 0.5, row: saved.splits.row ?? 0.5 };
  const n = Math.min(MAX_PANELS, Math.max(1, saved?.layout ?? 1));
  setLayout(n, saved?.panels ?? []);

  await refreshMeta();

  setInterval(() => { for (const p of panels) p.pollLive(); }, LIVE_POLL_MS);
  setInterval(refreshMeta, META_POLL_MS);
}

init().catch((e) => {
  statusDot.className = "dot dot-error";
  statusText.textContent = `초기화 실패: ${e.message}`;
});
