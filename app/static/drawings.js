/* 차트 위 그리기 도구 (추세선·수평선·가격 범위 측정).
 *
 * lightweight-charts에는 그리기 기능이 없으므로 메인 차트 위에 캔버스를 얹고,
 * 앵커를 (time초, price)로 저장한 뒤 매 프레임 차트 좌표계로 변환해 그린다.
 * 좌표 변환은 봉 시간의 이진 탐색 + 논리 인덱스 보간이라 봉 종류를 바꿔도
 * 그린 위치가 유지된다.
 *
 * 상태 머신:
 *  - idle:    오버레이 pointer-events:none. 차트 클릭이 도형에 닿으면 선택.
 *  - armed:   도구 활성. 클릭으로 점을 찍어 도형 생성 (ESC 취소).
 *  - selected:도형 선택됨. 끝점 핸들/몸통 드래그로 수정, Del 삭제, 빈 곳 클릭 해제.
 */
"use strict";

const DRAW_COLOR = "#2962ff";
const DRAW_UP = "rgba(38, 166, 154, 0.18)";
const DRAW_DOWN = "rgba(239, 83, 80, 0.18)";
const HIT_PX = 7;      // 선택 판정 거리
const HANDLE_R = 5;    // 끝점 핸들 반지름
const ALERT_COOLDOWN_MS = 60_000; // 같은 도형의 연속 알림 최소 간격

class DrawingLayer {
  /**
   * @param opts {container, chart, series, getBars, getFmt, onChange, onToolChange}
   *  - container: pane-main 요소 (position: relative)
   *  - getBars(): 현재 캔들 배열, getFmt(): 가격 포맷터
   *  - onChange(drawings): 도형 목록이 바뀔 때(생성/수정/삭제)
   *  - onToolChange(tool): 도구 상태가 바뀔 때 (버튼 UI 갱신용)
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.drawings = [];
    this.tool = null;
    this.selectedId = null;
    this.pending = null;   // 생성 중 도형 {type, p1}
    this.drag = null;      // {id, part: 'p1'|'p2'|'body', start: {t, p}, orig}
    this.mouse = null;     // 캔버스 좌표 {x, y}
    this.destroyed = false;
    this._suppressClick = false;

    this._alertState = new Map(); // id → {side, lastFired} (런타임 전용)

    this.canvas = document.createElement("canvas");
    this.canvas.className = "draw-overlay";
    this.container.appendChild(this.canvas);

    // 선택된 도형 옆에 뜨는 미니 툴바 (알림 토글 · 삭제)
    this.toolbar = document.createElement("div");
    this.toolbar.className = "draw-toolbar";
    this.toolbar.hidden = true;
    this.alertBtn = document.createElement("button");
    this.alertBtn.type = "button";
    this.delBtn = document.createElement("button");
    this.delBtn.type = "button";
    this.delBtn.textContent = "삭제";
    this.toolbar.appendChild(this.alertBtn);
    this.toolbar.appendChild(this.delBtn);
    this.container.appendChild(this.toolbar);
    this.toolbar.addEventListener("click", (e) => e.stopPropagation());
    this.alertBtn.addEventListener("click", () => {
      const d = this.drawings.find((x) => x.id === this.selectedId);
      if (!d) return;
      d.alert = !d.alert;
      this._alertState.delete(d.id);
      this.onAlertToggle?.(d);
      this.onChange?.(this.getDrawings());
    });
    this.delBtn.addEventListener("click", () => {
      this.drawings = this.drawings.filter((d) => d.id !== this.selectedId);
      this.selectedId = null;
      this._updatePointerMode();
      this.onChange?.(this.getDrawings());
    });

    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(this.container);
    this._resize();

    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
    this._onContainerClick = (e) => this._containerClick(e);
    this._onKeyDown = (e) => this._keyDown(e);
    this.canvas.addEventListener("pointerdown", this._onPointerDown);
    this.canvas.addEventListener("pointermove", this._onPointerMove);
    this.canvas.addEventListener("pointerup", this._onPointerUp);
    this.container.addEventListener("click", this._onContainerClick);
    document.addEventListener("keydown", this._onKeyDown);

    const loop = () => {
      if (this.destroyed) return;
      this._render();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this._raf);
    this.ro.disconnect();
    this.container.removeEventListener("click", this._onContainerClick);
    document.removeEventListener("keydown", this._onKeyDown);
    this.canvas.remove();
    this.toolbar.remove();
  }

  setDrawings(arr) {
    this.drawings = Array.isArray(arr) ? structuredClone(arr) : [];
    this.selectedId = null;
    this.pending = null;
    this._alertState.clear();
    this._updatePointerMode();
  }

  /* ---------- 알림 ---------- */

  /** t(초) 시점의 선 가격. 알림 대상이 아니거나 계산 불가면 null */
  _lineValueAt(d, t) {
    if (d.type === "hline") return d.p1.p;
    if (d.type === "trend" && d.p2) {
      const t1 = d.p1.t, t2 = d.p2.t;
      if (t1 === t2) return null;
      if (t < Math.min(t1, t2)) return null; // 시작 전에는 비활성
      // 구간 오른쪽으로는 연장선으로 계산
      return d.p1.p + ((d.p2.p - d.p1.p) * (t - t1)) / (t2 - t1);
    }
    return null;
  }

  /** 최신 가격으로 알림 도형들을 평가한다. 교차(돌파)가 생기면 배열로 반환 */
  evaluateAlerts(price, t) {
    const out = [];
    const now = Date.now();
    for (const d of this.drawings) {
      if (!d.alert) continue;
      const v = this._lineValueAt(d, t);
      if (v === null) continue;
      const side = price > v ? 1 : price < v ? -1 : 0;
      if (side === 0) continue;
      const st = this._alertState.get(d.id) ?? { side: 0, lastFired: 0 };
      if (st.side !== 0 && side !== st.side && now - st.lastFired > ALERT_COOLDOWN_MS) {
        out.push({ drawing: d, value: v, price, direction: side });
        st.lastFired = now;
      }
      st.side = side;
      this._alertState.set(d.id, st);
    }
    return out;
  }

  getDrawings() {
    return structuredClone(this.drawings);
  }

  setTool(tool) {
    this.tool = tool;
    this.pending = null;
    this.selectedId = null;
    this._updatePointerMode();
    this.onToolChange?.(tool);
  }

  clearAll() {
    if (this.drawings.length === 0) return;
    this.drawings = [];
    this.selectedId = null;
    this.pending = null;
    this._updatePointerMode();
    this.onChange?.(this.getDrawings());
  }

  /* ---------- 좌표 변환 ---------- */

  _barInterval() {
    const bars = this.getBars();
    if (bars.length >= 2) return bars[bars.length - 1].time - bars[bars.length - 2].time;
    return 60;
  }

  _timeToX(t) {
    const bars = this.getBars();
    if (bars.length === 0) return null;
    const ts = this.chart.timeScale();
    const last = bars.length - 1;
    const tf = this._barInterval();
    let logical;
    if (t <= bars[0].time) {
      logical = (t - bars[0].time) / tf;
    } else if (t >= bars[last].time) {
      logical = last + (t - bars[last].time) / tf;
    } else {
      let lo = 0, hi = last;
      while (lo < hi - 1) {
        const m = (lo + hi) >> 1;
        if (bars[m].time <= t) lo = m; else hi = m;
      }
      logical = lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
    }
    return this.chart.timeScale().logicalToCoordinate(logical) ?? null;
  }

  _xToTime(x, snap = true) {
    const bars = this.getBars();
    if (bars.length === 0) return null;
    const logical = this.chart.timeScale().coordinateToLogical(x);
    if (logical === null) return null;
    const last = bars.length - 1;
    const tf = this._barInterval();
    const idx = snap ? Math.round(logical) : logical;
    if (idx <= 0) return bars[0].time + Math.round(idx) * tf;
    if (idx >= last) return bars[last].time + Math.round(idx - last) * tf;
    if (snap) return bars[Math.round(idx)].time;
    const lo = Math.floor(idx);
    return bars[lo].time + (idx - lo) * (bars[lo + 1].time - bars[lo].time);
  }

  _priceToY(p) {
    return this.series.priceToCoordinate(p) ?? null;
  }

  _yToPrice(y) {
    return this.series.coordinateToPrice(y) ?? null;
  }

  _eventPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _anchorAt(x, y) {
    const t = this._xToTime(x, true);
    const p = this._yToPrice(y);
    if (t === null || p === null) return null;
    return { t, p };
  }

  /* ---------- 이벤트 ---------- */

  _updatePointerMode() {
    const active = this.tool !== null || this.selectedId !== null;
    this.canvas.style.pointerEvents = active ? "auto" : "none";
    this.canvas.style.cursor = this.tool ? "crosshair" : "default";
  }

  _pointerDown(e) {
    if (e.button !== 0) return;
    const pt = this._eventPoint(e);

    if (this.tool) {
      const a = this._anchorAt(pt.x, pt.y);
      if (!a) return;
      if (this.tool === "hline") {
        this._commit({ id: crypto.randomUUID(), type: "hline", p1: a });
        this.setTool(null);
      } else if (!this.pending) {
        this.pending = { type: this.tool, p1: a };
      } else {
        this._commit({ id: crypto.randomUUID(), type: this.pending.type, p1: this.pending.p1, p2: a });
        this.pending = null;
        this.setTool(null);
      }
      return;
    }

    if (this.selectedId !== null) {
      // 선택 상태: 핸들/몸통이면 드래그 시작, 아니면 다른 도형 선택 or 해제
      const sel = this.drawings.find((d) => d.id === this.selectedId);
      const part = sel ? this._hitPart(sel, pt) : null;
      if (part) {
        const a = this._anchorAt(pt.x, pt.y);
        if (!a) return;
        this.drag = { id: sel.id, part, start: a, orig: structuredClone(sel) };
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      const other = this._hitTest(pt);
      this.selectedId = other?.id ?? null;
      this._suppressClick = true;
      this._updatePointerMode();
    }
  }

  _pointerMove(e) {
    this.mouse = this._eventPoint(e);
    if (this.drag) {
      const a = this._anchorAt(this.mouse.x, this.mouse.y);
      if (!a) return;
      const d = this.drawings.find((x) => x.id === this.drag.id);
      if (!d) return;
      const { part, start, orig } = this.drag;
      if (part === "body") {
        const dt = a.t - start.t;
        const dp = a.p - start.p;
        d.p1 = { t: orig.p1.t + dt, p: orig.p1.p + dp };
        if (orig.p2) d.p2 = { t: orig.p2.t + dt, p: orig.p2.p + dp };
      } else {
        d[part] = a;
      }
    }
  }

  _pointerUp(e) {
    if (this.drag) {
      this.canvas.releasePointerCapture?.(e.pointerId);
      this.drag = null;
      this._suppressClick = true;
      this.onChange?.(this.getDrawings());
    }
  }

  _containerClick(e) {
    // idle 상태에서 차트 클릭 → 도형 선택 (드래그 직후 클릭은 무시)
    if (this._suppressClick) { this._suppressClick = false; return; }
    if (this.tool || this.selectedId !== null) return;
    const rect = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const hit = this._hitTest(pt);
    if (hit) {
      this.selectedId = hit.id;
      this._updatePointerMode();
    }
  }

  _keyDown(e) {
    if (this.destroyed) return;
    if (e.key === "Escape") {
      if (this.pending || this.tool) { this.pending = null; this.setTool(null); }
      else if (this.selectedId !== null) { this.selectedId = null; this._updatePointerMode(); }
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selectedId !== null) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      this.drawings = this.drawings.filter((d) => d.id !== this.selectedId);
      this.selectedId = null;
      this._updatePointerMode();
      this.onChange?.(this.getDrawings());
    }
  }

  _commit(drawing) {
    this.drawings.push(drawing);
    this.onChange?.(this.getDrawings());
  }

  /* ---------- 판정 ---------- */

  _segDist(pt, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let u = len2 ? ((pt.x - x1) * dx + (pt.y - y1) * dy) / len2 : 0;
    u = Math.max(0, Math.min(1, u));
    const px = x1 + u * dx, py = y1 + u * dy;
    return Math.hypot(pt.x - px, pt.y - py);
  }

  _coords(d) {
    const x1 = this._timeToX(d.p1.t);
    const y1 = this._priceToY(d.p1.p);
    if (x1 === null || y1 === null) return null;
    if (d.type === "hline") return { x1: 0, y1, x2: this.canvas.clientWidth, y2: y1 };
    if (!d.p2) return null;
    const x2 = this._timeToX(d.p2.t);
    const y2 = this._priceToY(d.p2.p);
    if (x2 === null || y2 === null) return null;
    return { x1, y1, x2, y2 };
  }

  _hitPart(d, pt) {
    const c = this._coords(d);
    if (!c) return null;
    if (d.type !== "hline") {
      if (Math.hypot(pt.x - c.x1, pt.y - c.y1) <= HANDLE_R + 3) return "p1";
      if (Math.hypot(pt.x - c.x2, pt.y - c.y2) <= HANDLE_R + 3) return "p2";
    }
    if (d.type === "range") {
      const inX = pt.x >= Math.min(c.x1, c.x2) - HIT_PX && pt.x <= Math.max(c.x1, c.x2) + HIT_PX;
      const inY = pt.y >= Math.min(c.y1, c.y2) - HIT_PX && pt.y <= Math.max(c.y1, c.y2) + HIT_PX;
      return inX && inY ? "body" : null;
    }
    return this._segDist(pt, c.x1, c.y1, c.x2, c.y2) <= HIT_PX ? "body" : null;
  }

  _hitTest(pt) {
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      if (this._hitPart(this.drawings[i], pt)) return this.drawings[i];
    }
    return null;
  }

  /* ---------- 렌더 ---------- */

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  _render() {
    const ctx = this.canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    if (this.getBars().length === 0) return;

    for (const d of this.drawings) {
      this._renderDrawing(ctx, d, d.id === this.selectedId);
    }
    // 생성 중 미리보기
    if (this.pending && this.mouse) {
      const a = this._anchorAt(this.mouse.x, this.mouse.y);
      if (a) this._renderDrawing(ctx, { ...this.pending, p2: a, id: "__pending__" }, false, true);
    }
    this._updateToolbar();
  }

  _updateToolbar() {
    const sel = this.selectedId !== null ? this.drawings.find((d) => d.id === this.selectedId) : null;
    const c = sel ? this._coords(sel) : null;
    if (!sel || !c) {
      this.toolbar.hidden = true;
      return;
    }
    this.alertBtn.hidden = sel.type === "range"; // 범위 측정에는 알림 없음
    this.alertBtn.textContent = sel.alert ? "🔔 알림 끄기" : "🔕 알림 켜기";
    this.alertBtn.classList.toggle("on", !!sel.alert);
    this.toolbar.hidden = false;
    const midX = (c.x1 + c.x2) / 2;
    const midY = (c.y1 + c.y2) / 2;
    const w = this.toolbar.offsetWidth || 140;
    const h = this.toolbar.offsetHeight || 26;
    const x = Math.max(4, Math.min(this.canvas.clientWidth - w - 4, midX - w / 2));
    const y = Math.max(4, Math.min(this.canvas.clientHeight - h - 4, midY - h - 12));
    this.toolbar.style.left = `${x}px`;
    this.toolbar.style.top = `${y}px`;
  }

  _renderDrawing(ctx, d, selected, preview = false) {
    const c = this._coords(d);
    if (!c) return;
    ctx.save();
    ctx.globalAlpha = preview ? 0.7 : 1;

    if (d.type === "range") {
      const up = d.p2.p >= d.p1.p;
      ctx.fillStyle = up ? DRAW_UP : DRAW_DOWN;
      const rx = Math.min(c.x1, c.x2), ry = Math.min(c.y1, c.y2);
      const rw = Math.abs(c.x2 - c.x1), rh = Math.abs(c.y2 - c.y1);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = up ? "#26a69a" : "#ef5350";
      ctx.lineWidth = 1;
      ctx.strokeRect(rx, ry, rw, rh);
      this._renderRangeLabel(ctx, d, c, up);
    } else {
      ctx.strokeStyle = DRAW_COLOR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c.x1, c.y1);
      ctx.lineTo(c.x2, c.y2);
      ctx.stroke();
      if (d.type === "hline") this._renderHlineLabel(ctx, d, c);
      if (d.alert) {
        // 알림이 걸린 선에는 종 아이콘 표시
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const bx = d.type === "hline" ? 60 : Math.max(c.x1, c.x2);
        const by = d.type === "hline" ? c.y1 - 3 : (c.x1 > c.x2 ? c.y1 : c.y2) - 6;
        ctx.fillText("🔔", bx, by);
      }
    }

    if (selected) {
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = DRAW_COLOR;
      ctx.lineWidth = 1.5;
      const handles = d.type === "hline"
        ? [[this.canvas.clientWidth / 2, c.y1]]
        : [[c.x1, c.y1], [c.x2, c.y2]];
      for (const [hx, hy] of handles) {
        ctx.beginPath();
        ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _labelBox(ctx, lines, cx, cy, above) {
    ctx.font = "11px -apple-system, 'Segoe UI', Roboto, 'Noto Sans KR', sans-serif";
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
    const lineH = 15;
    const h = lines.length * lineH + 8;
    let x = cx - w / 2;
    let y = above ? cy - h - 6 : cy + 6;
    x = Math.max(2, Math.min(this.canvas.clientWidth - w - 2, x));
    y = Math.max(2, Math.min(this.canvas.clientHeight - h - 2, y));
    ctx.fillStyle = "rgba(30, 34, 45, 0.92)";
    ctx.strokeStyle = "#2a2e39";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d1d4dc";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, x + w / 2, y + 5 + i * lineH));
  }

  _renderRangeLabel(ctx, d, c, up) {
    const fmt = this.getFmt();
    const dp = d.p2.p - d.p1.p;
    const pct = d.p1.p ? (dp / d.p1.p) * 100 : 0;
    const tf = this._barInterval();
    const nBars = Math.round(Math.abs(d.p2.t - d.p1.t) / tf);
    const dur = this._durationText(Math.abs(d.p2.t - d.p1.t));
    const sign = dp >= 0 ? "+" : "−";
    const lines = [
      `${sign}${fmt.format(Math.abs(dp))} (${sign}${Math.abs(pct).toFixed(2)}%)`,
      `${nBars}봉 · ${dur}`,
    ];
    this._labelBox(ctx, lines, (c.x1 + c.x2) / 2, up ? Math.min(c.y1, c.y2) : Math.max(c.y1, c.y2), up);
  }

  _renderHlineLabel(ctx, d, c) {
    const fmt = this.getFmt();
    ctx.font = "11px -apple-system, 'Segoe UI', Roboto, 'Noto Sans KR', sans-serif";
    const text = fmt.format(d.p1.p);
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = DRAW_COLOR;
    ctx.beginPath();
    ctx.roundRect(this.canvas.clientWidth - w - 4, c.y1 - 9, w, 18, 3);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, this.canvas.clientWidth - w / 2 - 4, c.y1);
  }

  _durationText(sec) {
    if (sec >= 86400 * 2) return `${(sec / 86400).toFixed(1)}일`;
    if (sec >= 3600) return `${(sec / 3600).toFixed(1)}시간`;
    return `${Math.round(sec / 60)}분`;
  }
}
