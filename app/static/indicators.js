/* 기술적 지표 계산 (순수 함수).
 * 입력: 오름차순 캔들 배열 [{time, open, high, low, close, volume}, ...]
 * 출력: lightweight-charts 시리즈에 바로 넣을 수 있는 [{time, value}, ...]
 * 워밍업 구간(기간 미만)은 결과에서 제외한다.
 */
"use strict";

const Indicators = (() => {
  function sma(bars, period) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= period) sum -= bars[i - period].close;
      if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
    }
    return out;
  }

  function ema(bars, period) {
    const out = [];
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      if (prev === null) {
        // 첫 EMA는 첫 period개의 SMA로 시작
        if (i === period - 1) {
          let sum = 0;
          for (let j = 0; j < period; j++) sum += bars[j].close;
          prev = sum / period;
          out.push({ time: bars[i].time, value: prev });
        }
        continue;
      }
      prev = c * k + prev * (1 - k);
      out.push({ time: bars[i].time, value: prev });
    }
    return out;
  }

  function ma(bars, period, type) {
    return type === "EMA" ? ema(bars, period) : sma(bars, period);
  }

  function envelope(bars, period, percent) {
    const basis = sma(bars, period);
    const f = percent / 100;
    return {
      upper: basis.map((p) => ({ time: p.time, value: p.value * (1 + f) })),
      lower: basis.map((p) => ({ time: p.time, value: p.value * (1 - f) })),
    };
  }

  function bollinger(bars, period, mult) {
    const upper = [], middle = [], lower = [];
    let sum = 0, sumSq = 0;
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      sum += c; sumSq += c * c;
      if (i >= period) {
        const old = bars[i - period].close;
        sum -= old; sumSq -= old * old;
      }
      if (i >= period - 1) {
        const mean = sum / period;
        const variance = Math.max(0, sumSq / period - mean * mean);
        const sd = Math.sqrt(variance);
        middle.push({ time: bars[i].time, value: mean });
        upper.push({ time: bars[i].time, value: mean + mult * sd });
        lower.push({ time: bars[i].time, value: mean - mult * sd });
      }
    }
    return { upper, middle, lower };
  }

  function rsi(bars, period) {
    const out = [];
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < bars.length; i++) {
      const diff = bars[i].close - bars[i - 1].close;
      const gain = Math.max(0, diff), loss = Math.max(0, -diff);
      if (i <= period) {
        avgGain += gain / period;
        avgLoss += loss / period;
        if (i === period) {
          const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
          out.push({ time: bars[i].time, value: 100 - 100 / (1 + rs) });
        }
      } else {
        // Wilder 평활
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
        out.push({ time: bars[i].time, value: 100 - 100 / (1 + rs) });
      }
    }
    return out;
  }

  function macd(bars, fastPeriod, slowPeriod, signalPeriod, upColor, downColor) {
    const fast = ema(bars, fastPeriod);
    const slow = ema(bars, slowPeriod);
    const byTime = new Map(fast.map((p) => [p.time, p.value]));
    const macdLine = [];
    for (const p of slow) {
      const f = byTime.get(p.time);
      if (f !== undefined) macdLine.push({ time: p.time, value: f - p.value });
    }
    // 시그널 = MACD 라인의 EMA
    const sigK = 2 / (signalPeriod + 1);
    const signal = [];
    let prev = null;
    for (let i = 0; i < macdLine.length; i++) {
      const v = macdLine[i].value;
      if (prev === null) {
        if (i === signalPeriod - 1) {
          let sum = 0;
          for (let j = 0; j < signalPeriod; j++) sum += macdLine[j].value;
          prev = sum / signalPeriod;
          signal.push({ time: macdLine[i].time, value: prev });
        }
        continue;
      }
      prev = v * sigK + prev * (1 - sigK);
      signal.push({ time: macdLine[i].time, value: prev });
    }
    const sigByTime = new Map(signal.map((p) => [p.time, p.value]));
    const hist = [];
    for (const p of macdLine) {
      const s = sigByTime.get(p.time);
      if (s !== undefined) {
        const v = p.value - s;
        hist.push({ time: p.time, value: v, color: v >= 0 ? upColor : downColor });
      }
    }
    return { macd: macdLine, signal, hist };
  }

  return { sma, ema, ma, envelope, bollinger, rsi, macd };
})();
