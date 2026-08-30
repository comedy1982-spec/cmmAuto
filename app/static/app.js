/* cmmAuto 차트 뷰어 프론트엔드 — 멀티 차트 (최대 4분할, 트레이딩뷰 스타일)
 *
 * - 툴바의 분할 버튼(1/2/3/4)으로 화면을 나누고, 경계선을 드래그해 프레임 크기 조절
 * - 각 패널은 거래소/심볼/봉을 독립 선택하고, 자체적으로 과거 로드·실시간 갱신
 * - 지표(이동평균선·Envelope·볼린저·거래량·RSI·MACD)는 패널마다 독립 설정
 * - 분할 상태·크기·패널별 선택·패널별 지표 설정은 localStorage에 저장되어 유지
 */

const LIVE_POLL_MS = 2000;
const META_POLL_MS = 10000;
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

// 수집 봉 외에 항상 노출하는 파생 봉(서버가 저장 데이터에서 리샘플링)
const EXTRA_TFS = ["1w", "1M"];
const TF_RE = /^([1-9]\d{0,2})([mhdwM])$/;
const TF_UNITS = [
  { value: "m", label: "분" },
  { value: "h", label: "시간" },
  { value: "d", label: "일" },
  { value: "w", label: "주" },
  { value: "M", label: "월" },
];

let meta = null; // /api/meta 응답 (전 패널 공유)

/* ---------- 심볼 즐겨찾기 + 마켓 목록 캐시 (전 패널 공유) ---------- */

const FAV_KEY = "cmmauto.favorites.v1";

function loadFavorites() {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY));
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

const favorites = loadFavorites(); // "거래소|심볼" 문자열 집합

function toggleFavorite(exchange, symbol) {
  const key = `${exchange}|${symbol}`;
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  localStorage.setItem(FAV_KEY, JSON.stringify([...favorites]));
}

function isFavorite(exchange, symbol) {
  return favorites.has(`${exchange}|${symbol}`);
}

const marketsCache = new Map(); // exchange → Promise<string[]>

function getMarkets(exchange) {
  if (!marketsCache.has(exchange)) {
    const p = api(`/api/markets?exchange=${encodeURIComponent(exchange)}`)
      .then((r) => r.symbols)
      .catch(() => {
        marketsCache.delete(exchange); // 실패 시 다음에 재시도
        return meta?.exchanges?.[exchange]?.symbols ?? [];
      });
    marketsCache.set(exchange, p);
  }
  return marketsCache.get(exchange);
}

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

/* ---------- 한국시간(KST) 표시 ---------- */

const KST = "Asia/Seoul";
const kstFmt = {
  year: new Intl.DateTimeFormat("ko-KR", { timeZone: KST, year: "numeric" }),
  month: new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "short" }),
  day: new Intl.DateTimeFormat("ko-KR", { timeZone: KST, day: "numeric" }),
  time: new Intl.DateTimeFormat("ko-KR", { timeZone: KST, hour: "2-digit", minute: "2-digit", hour12: false }),
  full: new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    year: "2-digit", month: "numeric", day: "numeric", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }),
};

function kstTickMark(time, tickMarkType) {
  const d = new Date(time * 1000);
  const T = LightweightCharts.TickMarkType;
  switch (tickMarkType) {
    case T.Year: return kstFmt.year.format(d);
    case T.Month: return kstFmt.month.format(d);
    case T.DayOfMonth: return kstFmt.day.format(d);
    default: return kstFmt.time.format(d);
  }
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
    timeScale: {
      borderColor: "#2a2e39",
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: kstTickMark, // 시간축을 한국시간으로 표시
    },
    localization: {
      locale: "ko-KR",
      timeFormatter: (t) => kstFmt.full.format(new Date(t * 1000)), // 십자선 시간 라벨 (KST)
    },
  };
}

const lineDefaults = {
  lineWidth: 1,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
};

/* ---------- 가격 알림 (토스트 + 알림음 + 브라우저 알림) ---------- */

const toastWrap = document.createElement("div");
toastWrap.className = "toast-wrap";
document.body.appendChild(toastWrap);

function showToast(title, body) {
  const el = document.createElement("div");
  el.className = "toast";
  const b = document.createElement("b");
  b.textContent = title;
  const s = document.createElement("span");
  s.textContent = body;
  el.appendChild(b);
  el.appendChild(s);
  el.addEventListener("click", () => el.remove());
  toastWrap.appendChild(el);
  setTimeout(() => el.remove(), 10_000);
}

let audioCtx = null;
function ensureAudio() {
  // AudioContext는 사용자 제스처(알림 토글 클릭) 시점에 만들어야 재생이 허용된다
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch { /* 소리 미지원 환경 */ }
}

function beep() {
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime;
    for (const [freq, delay] of [[880, 0], [1175, 0.18]]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, t0 + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + delay + 0.25);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + 0.3);
    }
  } catch { /* ignore */ }
}

function fireLineAlert(panel, trig) {
  const typeName = trig.drawing.type === "hline" ? "수평선" : "추세선";
  const dir = trig.direction > 0 ? "상향 돌파" : "하향 돌파";
  const title = `${panel.sel.symbol} ${typeName} ${dir}`;
  const body = `현재가 ${panel.fmt.format(trig.price)} · 기준 ${panel.fmt.format(trig.value)} (${panel.sel.exchange} · ${panel.sel.timeframe})`;
  showToast(title, body);
  beep();
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body }); } catch { /* ignore */ }
  }
}

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
    // 그리기 도형: "거래소|심볼" 키로 보관 (심볼을 바꿔도 각자 유지)
    this.drawingsByKey = sel.drawings && typeof sel.drawings === "object" ? sel.drawings : {};
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
        <div class="field indicator-field sym-field">
          <button type="button" class="indicator-btn sym-btn" aria-label="심볼 선택">–</button>
          <div class="indicator-panel sym-panel" hidden>
            <input type="text" class="sym-search" placeholder="심볼 검색 (예: btc, doge)" autocomplete="off" />
            <div class="sym-list"></div>
          </div>
        </div>
        <div class="field indicator-field tf-field">
          <div class="segmented tf-group" role="group" aria-label="타임프레임"></div>
          <div class="indicator-panel tf-custom-panel" hidden>
            <div class="ind-title">사용자 지정 봉</div>
            <div class="ind-row">
              <input type="number" class="tf-custom-n" min="1" max="999" step="1" value="3" />
              <select class="tf-custom-unit"></select>
              <button type="button" class="lay-save-btn tf-custom-apply">적용</button>
            </div>
            <div class="lay-msg tf-custom-msg"></div>
          </div>
        </div>
        <div class="field indicator-field">
          <button type="button" class="indicator-btn ind-btn" aria-expanded="false">지표 ▾</button>
          <div class="indicator-panel ind-popover" hidden></div>
        </div>
        <div class="segmented draw-group" role="group" aria-label="그리기 도구">
          <button type="button" data-tool="trend" title="추세선 (두 점 클릭)">╱</button>
          <button type="button" data-tool="hline" title="수평선 (한 점 클릭)">━</button>
          <button type="button" data-tool="range" title="가격 범위 측정 (두 점 클릭)">⇕</button>
          <button type="button" data-tool="clear" title="이 차트의 그리기 모두 삭제">지움</button>
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
      symBtn: $("sym-btn"),
      symPanel: $("sym-panel"),
      symSearch: $("sym-search"),
      symList: $("sym-list"),
      tfGroup: $("tf-group"),
      tfCustomPanel: $("tf-custom-panel"),
      tfCustomN: $("tf-custom-n"),
      tfCustomUnit: $("tf-custom-unit"),
      tfCustomApply: $("tf-custom-apply"),
      tfCustomMsg: $("tf-custom-msg"),
      indBtn: $("ind-btn"),
      indPanel: $("ind-popover"),
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
      // 새 거래소의 기본 심볼: 즐겨찾기 → 기본 수집 심볼 순
      const fav = [...favorites].find((k) => k.startsWith(this.sel.exchange + "|"));
      this.sel.symbol = fav ? fav.split("|")[1] : this.exchangeMeta()?.symbols?.[0] ?? null;
      this.sel.timeframe = this.firstSupportedTimeframe();
      this.renderToolbar();
      saveLayout();
      this.loadInitial();
    });

    // 심볼 검색 팝오버
    this.els.symBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = this.els.symPanel.hidden;
      closeAllIndicatorPopovers();
      closeLayoutPopover();
      if (open) {
        this.els.symPanel.hidden = false;
        this.els.symBtn.classList.add("open");
        this.els.symSearch.value = "";
        this.renderSymbolList("");
        this.els.symSearch.focus();
      }
    });
    this.els.symPanel.addEventListener("click", (e) => e.stopPropagation());
    this.els.symSearch.addEventListener("input", () => this.renderSymbolList(this.els.symSearch.value));
    this.els.symSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.els.symList.querySelector(".sym-row");
        if (first) first.click();
      }
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

    // 사용자 지정 봉 입력
    for (const u of TF_UNITS) {
      const o = document.createElement("option");
      o.value = u.value;
      o.textContent = u.label;
      this.els.tfCustomUnit.appendChild(o);
    }
    this.els.tfCustomPanel.addEventListener("click", (e) => e.stopPropagation());
    const applyCustomTf = () => {
      const n = Number(this.els.tfCustomN.value);
      const unit = this.els.tfCustomUnit.value;
      if (!Number.isInteger(n) || n < 1 || n > 999) {
        this.els.tfCustomMsg.textContent = "1~999 사이의 정수를 입력해 주세요";
        this.els.tfCustomMsg.className = "lay-msg tf-custom-msg err";
        return;
      }
      this.sel.timeframe = `${n}${unit}`;
      this.closeIndicatorPopover();
      this.renderTimeframes();
      saveLayout();
      this.loadInitial();
    };
    this.els.tfCustomApply.addEventListener("click", applyCustomTf);
    this.els.tfCustomN.addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustomTf(); });
  }

  closeIndicatorPopover() {
    this.els.indPanel.hidden = true;
    this.els.indBtn.classList.remove("open");
    this.els.indBtn.setAttribute("aria-expanded", "false");
    this.els.tfCustomPanel.hidden = true;
    this.els.symPanel.hidden = true;
    this.els.symBtn.classList.remove("open");
  }

  /** 검색어에 맞는 심볼 목록 렌더 (즐겨찾기 우선, ★ 토글 포함) */
  async renderSymbolList(query) {
    const exchange = this.sel.exchange;
    const all = await getMarkets(exchange);
    if (this.destroyed || this.els.symPanel.hidden || exchange !== this.sel.exchange) return;

    const q = query.trim().toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    const favs = all.filter((s) => isFavorite(exchange, s) && match(s));
    const rest = all.filter((s) => !isFavorite(exchange, s) && match(s));
    const MAX_ROWS = 300;
    const shown = [...favs, ...rest].slice(0, MAX_ROWS);

    this.els.symList.innerHTML = "";
    if (shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sym-empty";
      empty.textContent = "일치하는 심볼이 없습니다";
      this.els.symList.appendChild(empty);
      return;
    }
    for (const sym of shown) {
      const row = document.createElement("div");
      row.className = "sym-row";
      row.classList.toggle("current", sym === this.sel.symbol);

      const star = document.createElement("button");
      star.type = "button";
      star.className = "sym-star" + (isFavorite(exchange, sym) ? " on" : "");
      star.textContent = "★";
      star.title = "즐겨찾기";
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(exchange, sym);
        this.renderSymbolList(this.els.symSearch.value);
      });
      row.appendChild(star);

      const name = document.createElement("span");
      name.className = "sym-name";
      name.textContent = sym;
      row.appendChild(name);

      row.addEventListener("click", () => {
        this.sel.symbol = sym;
        this.closeIndicatorPopover();
        this.renderToolbar();
        saveLayout();
        this.loadInitial();
      });
      this.els.symList.appendChild(row);
    }
    if (favs.length + rest.length > MAX_ROWS) {
      const more = document.createElement("div");
      more.className = "sym-empty";
      more.textContent = `${favs.length + rest.length - MAX_ROWS}개 더 있음 — 검색어를 입력하세요`;
      this.els.symList.appendChild(more);
    }
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
      // 분할 비율이 소수라 패널 크기가 소수점 픽셀일 수 있다.
      // clientWidth(반올림)를 쓰면 캔버스가 패널보다 1px 커져 넘칠 수 있으므로 내림 처리.
      const ro = new ResizeObserver(() => {
        const rect = paneEl.getBoundingClientRect();
        chartObj.resize(Math.floor(rect.width), Math.floor(rect.height));
      });
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

    // 그리기 레이어 (메인 차트 위 캔버스 오버레이)
    this.drawingLayer = new DrawingLayer({
      container: this.els.paneMain,
      chart: this.chart,
      series: this.candleSeries,
      getBars: () => this.bars,
      getFmt: () => this.fmt,
      onChange: (drawings) => {
        this.drawingsByKey[this.symKey()] = drawings;
        saveLayout();
      },
      onToolChange: (tool) => {
        for (const b of this.els.drawGroup.querySelectorAll("button[data-tool]")) {
          b.classList.toggle("active", b.dataset.tool === tool);
        }
      },
      onAlertToggle: (d) => {
        ensureAudio();
        if (d.alert && "Notification" in window && Notification.permission === "default") {
          Notification.requestPermission();
        }
        const typeName = d.type === "hline" ? "수평선" : "추세선";
        showToast(
          d.alert ? "알림 설정됨" : "알림 해제됨",
          d.alert
            ? `${this.sel.symbol} ${typeName}에 가격이 닿으면 알려드립니다`
            : `${this.sel.symbol} ${typeName} 알림을 껐습니다`,
        );
      },
    });
    this.els.drawGroup = this.root.querySelector(".draw-group");
    this.els.drawGroup.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tool]");
      if (!btn) return;
      const tool = btn.dataset.tool;
      if (tool === "clear") {
        if (this.drawingLayer.drawings.length && confirm("이 차트의 그리기를 모두 삭제할까요?")) {
          this.drawingLayer.clearAll();
        }
        return;
      }
      this.drawingLayer.setTool(this.drawingLayer.tool === tool ? null : tool);
    });
  }

  symKey() {
    return `${this.sel.exchange}|${this.sel.symbol}`;
  }

  destroy() {
    this.destroyed = true;
    this.loadToken++;
    this.drawingLayer.destroy();
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
    // 수집 봉이 아니어도 서버가 리샘플링해 주므로 형식만 맞으면 유지
    if (TF_RE.test(this.sel.timeframe ?? "")) return this.sel.timeframe;
    return meta.timeframes.includes("1h") ? "1h" : meta.timeframes[0];
  }

  renderToolbar() {
    const { exchange } = this.els;
    exchange.innerHTML = "";
    for (const [exId, ex] of Object.entries(meta.exchanges)) {
      const opt = document.createElement("option");
      opt.value = exId;
      const badge = ex.status?.market_type === "swap" ? " 선물" : ex.status?.quote === "KRW" ? " KRW" : "";
      opt.textContent = exId + badge;
      exchange.appendChild(opt);
    }
    exchange.value = this.sel.exchange;

    this.els.symBtn.textContent = `${this.sel.symbol ?? "–"} ▾`;

    this.renderTimeframes();
  }

  renderTimeframes() {
    this.els.tfGroup.innerHTML = "";
    // 수집 봉 + 주/월봉, 그리고 현재 선택된 사용자 지정 봉
    const list = [...meta.timeframes, ...EXTRA_TFS.filter((t) => !meta.timeframes.includes(t))];
    if (this.sel.timeframe && !list.includes(this.sel.timeframe)) list.push(this.sel.timeframe);

    for (const tf of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = tf;
      btn.classList.toggle("active", tf === this.sel.timeframe);
      btn.addEventListener("click", () => {
        this.sel.timeframe = tf;
        this.renderTimeframes();
        saveLayout();
        this.loadInitial();
      });
      this.els.tfGroup.appendChild(btn);
    }

    // 사용자 지정 봉 입력 열기
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.title = "사용자 지정 봉 (예: 3분, 2시간, 2주)";
    plus.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = this.els.tfCustomPanel.hidden;
      closeAllIndicatorPopovers();
      closeLayoutPopover();
      if (open) {
        const m = TF_RE.exec(this.sel.timeframe ?? "");
        if (m) {
          this.els.tfCustomN.value = m[1];
          this.els.tfCustomUnit.value = m[2];
        }
        this.els.tfCustomMsg.textContent = "";
        this.els.tfCustomPanel.hidden = false;
        this.els.tfCustomN.focus();
      }
    });
    this.els.tfGroup.appendChild(plus);
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
    this.drawingLayer.setDrawings(this.drawingsByKey[this.symKey()] ?? []);

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
      if (changed) {
        this.recomputeIndicators();
        const last = this.bars[this.bars.length - 1];
        for (const trig of this.drawingLayer.evaluateAlerts(last.close, last.time)) {
          fireLineAlert(this, trig);
        }
      }
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
    panels: panels.map((p) => ({ ...p.sel, indicators: p.settings, drawings: p.drawingsByKey })),
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
    // 검색으로 고른 심볼은 기본 수집 목록 밖일 수 있으므로 문자열이면 그대로 유지
    symbol: typeof sel.symbol === "string" && sel.symbol ? sel.symbol : exMeta.symbols[0],
    // 사용자 지정 봉(예: 2h, 45m)도 서버 리샘플링으로 표시 가능하므로 형식만 검증
    timeframe: TF_RE.test(sel.timeframe ?? "") ? sel.timeframe : meta.timeframes[0],
    indicators: sel.indicators ?? null,
    drawings: sel.drawings ?? null,
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

  const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
  closeScannerPopover();
  if (open) {
    layPanel.hidden = false;
    layBtn.classList.add("open");
    layBtn.setAttribute("aria-expanded", "true");
    buildLayoutPopover();
  }
});
layPanel.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => closeLayoutPopover());

/* ---------- 엔벨로프 스캐너 (전 마켓 감시 → 텔레그램 알림) ---------- */

const scanBtn = document.getElementById("scanner-btn");
const scanPanel = document.getElementById("scanner-panel");
const SCAN_TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"];
const SCAN_SIDE = { upper: "상단", lower: "하단" };
let scanRefreshTimer = null;

function closeScannerPopover() {
  scanPanel.hidden = true;
  scanBtn.classList.remove("open");
  scanBtn.setAttribute("aria-expanded", "false");
  if (scanRefreshTimer) {
    clearInterval(scanRefreshTimer);
    scanRefreshTimer = null;
  }
}

function scanMessage(text, isError = false) {
  const msg = scanPanel.querySelector(".scan-msg");
  if (msg) {
    msg.textContent = text;
    msg.className = `lay-msg scan-msg${isError ? " err" : ""}`;
  }
}

function fmtScanPrice(v) {
  if (v >= 1000) return Math.round(v).toLocaleString("ko-KR");
  if (v >= 1) return v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  return v.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
}

/** 상태 줄 + 최근 알림 목록만 갱신 (입력 폼은 건드리지 않는다) */
function renderScannerStatus(info) {
  scanBtn.classList.toggle("scan-on", !!info.settings.enabled);

  const stEl = scanPanel.querySelector(".scan-status");
  if (!stEl) return;
  const st = info.status;
  const lines = [];
  if (!info.settings.enabled) {
    lines.push("상태: 꺼짐");
  } else if (!st.last_sweep_finished) {
    lines.push("상태: 첫 스캔 진행 중…");
  } else {
    const ago = Math.max(0, Math.round(Date.now() / 1000 - st.last_sweep_finished));
    lines.push(`상태: 켜짐 · ${st.symbol_count}개 코인 · 스캔 ${st.sweep_seconds}s 소요 (${ago}s 전 완료)`);
    lines.push(`누적 알림 ${st.alerts_sent}건`);
  }
  if (st.last_error) lines.push(`⚠ 조회 오류: ${st.last_error}`);
  if (st.telegram_error) lines.push(`⚠ 텔레그램 오류: ${st.telegram_error}`);
  stEl.textContent = lines.join("\n");

  const listEl = scanPanel.querySelector(".scan-alerts");
  if (!listEl) return;
  listEl.innerHTML = "";
  const timeFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  for (const a of (info.alerts ?? []).slice(0, 20)) {
    const row = document.createElement("div");
    row.className = "scan-alert";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = timeFmt.format(new Date(a.time * 1000));
    const sym = document.createElement("span");
    sym.className = "s";
    sym.textContent = a.symbol;
    const side = document.createElement("span");
    side.className = `side-${a.side}`;
    side.textContent = `${SCAN_SIDE[a.side] ?? a.side} ±${a.percent}%`;
    const price = document.createElement("span");
    price.className = "p";
    price.textContent = fmtScanPrice(a.price);
    row.append(t, sym, side, price);
    listEl.appendChild(row);
  }
  if (!info.alerts?.length) {
    listEl.innerHTML = `<div class="lay-empty">아직 알림이 없습니다</div>`;
  }
}

async function buildScannerPopover() {
  scanPanel.innerHTML = "";
  let info;
  try {
    info = await api("/api/scanner");
  } catch (e) {
    scanPanel.innerHTML = `<div class="lay-empty">스캐너 정보를 불러오지 못했습니다: ${e.message}</div>`;
    return;
  }
  const s = { ...info.settings };

  const form = document.createElement("div");
  form.className = "ind-section";
  form.innerHTML = `<div class="ind-title">엔벨로프 스캐너 — 거래소 전 코인 감시</div>`;

  const enableRow = document.createElement("div");
  enableRow.className = "ind-row";
  enableRow.appendChild(checkboxLabel("스캐너 켜기 (밴드 터치 시 텔레그램 알림)", s.enabled, (v) => { s.enabled = v; }));
  form.appendChild(enableRow);

  const row1 = document.createElement("div");
  row1.className = "ind-row";
  const exSel = document.createElement("select");
  for (const exId of Object.keys(meta.exchanges)) {
    const o = document.createElement("option");
    o.value = exId;
    o.textContent = exId;
    exSel.appendChild(o);
  }
  exSel.value = s.exchange;
  exSel.addEventListener("change", () => { s.exchange = exSel.value; });
  const tfSel = document.createElement("select");
  for (const tf of SCAN_TFS) {
    const o = document.createElement("option");
    o.value = tf;
    o.textContent = tf;
    tfSel.appendChild(o);
  }
  tfSel.value = SCAN_TFS.includes(s.timeframe) ? s.timeframe : "3m";
  tfSel.addEventListener("change", () => { s.timeframe = tfSel.value; });
  const tfSub = document.createElement("span");
  tfSub.className = "sub";
  tfSub.textContent = "봉";
  row1.append(exSel, tfSel, tfSub);
  form.appendChild(row1);

  const row2 = document.createElement("div");
  row2.className = "ind-row";
  row2.appendChild(numberInput(s.period, 2, 400, 1, (v) => { s.period = v; }));
  const sub1 = document.createElement("span"); sub1.className = "sub"; sub1.textContent = "기간";
  row2.appendChild(sub1);
  row2.appendChild(numberInput(s.percent, 0.1, 50, 0.1, (v) => { s.percent = v; }));
  const sub2 = document.createElement("span"); sub2.className = "sub"; sub2.textContent = "%";
  row2.appendChild(sub2);
  row2.appendChild(numberInput(s.sweep_interval_seconds, 15, 3600, 5, (v) => { s.sweep_interval_seconds = v; }));
  const sub3 = document.createElement("span"); sub3.className = "sub"; sub3.textContent = "초 주기";
  row2.appendChild(sub3);
  form.appendChild(row2);

  const tokenField = document.createElement("div");
  tokenField.className = "scan-field";
  tokenField.innerHTML = `<span class="sub">텔레그램 봇 토큰 (@BotFather에서 발급)</span>`;
  const tokenInput = document.createElement("input");
  tokenInput.type = "password";
  tokenInput.autocomplete = "off";
  tokenInput.placeholder = "123456789:AAF...";
  tokenInput.value = s.telegram_token;
  tokenField.appendChild(tokenInput);
  form.appendChild(tokenField);

  const chatField = document.createElement("div");
  chatField.className = "scan-field";
  chatField.innerHTML = `<span class="sub">챗 ID (@userinfobot에게 /start 하면 확인)</span>`;
  const chatInput = document.createElement("input");
  chatInput.type = "text";
  chatInput.autocomplete = "off";
  chatInput.placeholder = "123456789";
  chatInput.value = s.telegram_chat_id;
  chatField.appendChild(chatInput);
  form.appendChild(chatField);

  const doSave = async () => {
    const body = {
      ...s,
      telegram_token: tokenInput.value.trim(),
      telegram_chat_id: chatInput.value.trim(),
    };
    const res = await fetch("/api/scanner/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error(d?.detail ?? `HTTP ${res.status}`);
    }
  };

  const actions = document.createElement("div");
  actions.className = "scan-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "lay-save-btn";
  saveBtn.textContent = "저장";
  saveBtn.addEventListener("click", async () => {
    try {
      await doSave();
      scanMessage(s.enabled ? "저장됨 — 곧 스캔이 시작됩니다" : "저장됨 (스캐너 꺼짐)");
      renderScannerStatus(await api("/api/scanner"));
    } catch (e) {
      scanMessage(`저장 실패: ${e.message}`, true);
    }
  });
  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.className = "scan-test-btn";
  testBtn.textContent = "테스트 전송";
  testBtn.addEventListener("click", async () => {
    try {
      await doSave(); // 입력 중인 토큰으로 바로 테스트되도록 먼저 저장
      scanMessage("전송 중…");
      const res = await fetch("/api/scanner/test", { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.detail ?? `HTTP ${res.status}`);
      }
      scanMessage("✅ 텔레그램으로 테스트 메시지를 보냈습니다");
    } catch (e) {
      scanMessage(`${e.message}`, true);
    }
  });
  actions.append(saveBtn, testBtn);
  form.appendChild(actions);

  const msg = document.createElement("div");
  msg.className = "lay-msg scan-msg";
  form.appendChild(msg);
  scanPanel.appendChild(form);

  const statusSection = document.createElement("div");
  statusSection.className = "ind-section";
  statusSection.innerHTML = `<div class="ind-title">최근 알림</div><div class="scan-status"></div><div class="scan-alerts"></div>`;
  scanPanel.appendChild(statusSection);

  renderScannerStatus(info);
  scanRefreshTimer = setInterval(async () => {
    try {
      renderScannerStatus(await api("/api/scanner"));
    } catch { /* 다음 주기에 재시도 */ }
  }, 5000);
}

scanBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = scanPanel.hidden;
  closeAllIndicatorPopovers();
  closeLayoutPopover();
  closeScannerPopover();
  if (open) {
    scanPanel.hidden = false;
    scanBtn.classList.add("open");
    scanBtn.setAttribute("aria-expanded", "true");
    buildScannerPopover();
  }
});
scanPanel.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => closeScannerPopover());

// 시작 시 한 번: 스캐너가 켜져 있으면 버튼에 표시
api("/api/scanner").then((info) => {
  scanBtn.classList.toggle("scan-on", !!info.settings.enabled);
}).catch(() => {});

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
