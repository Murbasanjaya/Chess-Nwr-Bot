'use strict';
// Tuning bobot evaluasi (metode Texel) terhadap label Stockfish.
//
//   node test/tools/tune.js <file-label[,file-label2,...]> [epoch] [--write]
//
// File label: "<fen>;<skor cp putih>" (keluaran label.js). Tiap posisi diubah
// jadi "jejak" koefisien parameter, lalu bobot dicari supaya
//   sigmoid(K * eval_kita)  ≈  sigmoid(skor_stockfish)
// meminimalkan kuadrat selisihnya (optimizer Adam, gradien analitik).
// Hasilnya ditulis ke engine/eval-params.json kalau pakai --write.
const fs = require('fs');
const path = require('path');
process.env.CATUR_DEFAULT_EVAL = process.env.CATUR_FROM_DEFAULT ? '1' : '';
const { Position } = require('../../engine/position.js');
const E = require('../../engine/evaluate.js');

const file = process.argv[2];
const epochs = parseInt(process.argv[3] || '1500', 10);
const write = process.argv.includes('--write');
const NP = E.NPARAMS;
const LN10_400 = Math.LN10 / 400;

// ---------- 1. ubah posisi jadi jejak koefisien ----------
const lines = file.split(',').flatMap(f => fs.readFileSync(f, 'utf8').split('\n')).filter(Boolean);
const idxList = [], valList = [], start = [0];
const phase = [], scale = [], extra = [], target = [], evalNow = [];
const T = new Float64Array(NP);
const pos = new Position();
let maxErr = 0;
for (const line of lines) {
  const [fen, cpStr] = line.split(';');
  let cp = parseInt(cpStr, 10);
  if (!isFinite(cp)) continue;
  if (cp > 2000) cp = 2000; if (cp < -2000) cp = -2000;
  pos.setFen(fen);
  T.fill(0);
  const ev = E.evaluateTrace(pos, T);
  for (let k = 0; k < NP; k++) if (T[k] !== 0) { idxList.push(k); valList.push(T[k]); }
  start.push(idxList.length);
  phase.push(E.TRACE_INFO.phase); scale.push(E.TRACE_INFO.scale); extra.push(E.TRACE_INFO.extra);
  target.push(1 / (1 + Math.pow(10, -cp / 400)));
  evalNow.push(ev);
}
const N = target.length;
const IDX = Int32Array.from(idxList), VAL = Float64Array.from(valList), ST = Int32Array.from(start);
const PH = Float64Array.from(phase), SC = Float64Array.from(scale), EX = Float64Array.from(extra), Y = Float64Array.from(target);

function evalLinear(w, i) {
  let mg = 0, eg = 0;
  for (let j = ST[i]; j < ST[i + 1]; j++) { const k = IDX[j], v = VAL[j]; mg += v * w[2 * k]; eg += v * w[2 * k + 1]; }
  return ((mg * PH[i] + eg * (24 - PH[i])) / 24) * SC[i] + EX[i];
}

// cek konsistensi: rekonstruksi linear harus sama dengan evaluate() asli
const w0 = Float64Array.from(E.W);
for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(evalLinear(w0, i) - evalNow[i]));
console.log(`${N} posisi, ${IDX.length} koefisien, selisih rekonstruksi maks ${maxErr.toFixed(2)}cp`);
if (maxErr > 3) { console.log('rekonstruksi nggak cocok — tuning dibatalkan'); process.exit(1); }

// pisah latih / validasi (tiap posisi ke-10 jadi validasi)
const isVal = i => i % 10 === 0;

function loss(w, K, val) {
  let s = 0, n = 0;
  for (let i = 0; i < N; i++) {
    if (isVal(i) !== val) continue;
    const p = 1 / (1 + Math.pow(10, -K * evalLinear(w, i) / 400));
    s += (p - Y[i]) * (p - Y[i]); n++;
  }
  return s / n;
}

// ---------- 2. cari skala K terbaik untuk bobot awal ----------
let K = 1, best = loss(w0, K, false);
for (const step of [0.5, 0.1, 0.02]) {
  for (let improved = true; improved;) {
    improved = false;
    for (const cand of [K + step, K - step]) {
      if (cand <= 0) continue;
      const l = loss(w0, cand, false);
      if (l < best) { best = l; K = cand; improved = true; }
    }
  }
}
console.log(`K=${K.toFixed(3)} | loss awal: latih ${best.toExponential(4)}, validasi ${loss(w0, K, true).toExponential(4)}`);

// ---------- 3. Adam ----------
const w = Float64Array.from(w0);
const m = new Float64Array(w.length), v = new Float64Array(w.length), g = new Float64Array(w.length);
const lr = 1.0, b1 = 0.9, b2 = 0.999, eps = 1e-8, l2 = 2e-7;
// parameter yang nggak boleh berubah (materi raja, slot kosong)
const frozen = new Uint8Array(w.length);
for (let k = 0; k < NP; k++) {
  const nm = E.NAMES[k];
  if (nm === 'material[0]' || nm === 'material[6]' || /^pst\[(\d+)\]$/.test(nm) && (parseInt(nm.slice(4), 10) >> 6) === 0) frozen[2 * k] = frozen[2 * k + 1] = 1;
}
let bestVal = loss(w, K, true), bestW = Float64Array.from(w), t0 = Date.now();
for (let ep = 1; ep <= epochs; ep++) {
  g.fill(0);
  let nTrain = 0;
  for (let i = 0; i < N; i++) {
    if (isVal(i)) continue;
    nTrain++;
    const e = evalLinear(w, i);
    const p = 1 / (1 + Math.pow(10, -K * e / 400));
    const d = 2 * (p - Y[i]) * p * (1 - p) * K * Math.LN10 / 400 * SC[i];
    const fm = d * PH[i] / 24, fe = d * (24 - PH[i]) / 24;
    for (let j = ST[i]; j < ST[i + 1]; j++) { const k = IDX[j], vv = VAL[j]; g[2 * k] += vv * fm; g[2 * k + 1] += vv * fe; }
  }
  // learning rate meluruh: langkah besar di awal, makin halus menjelang akhir
  const lrNow = Math.max(0.05, lr * Math.pow(0.996, ep));
  for (let j = 0; j < w.length; j++) {
    if (frozen[j]) continue;
    const gj = g[j] / nTrain + l2 * (w[j] - w0[j]);
    m[j] = b1 * m[j] + (1 - b1) * gj;
    v[j] = b2 * v[j] + (1 - b2) * gj * gj;
    const mh = m[j] / (1 - Math.pow(b1, ep)), vh = v[j] / (1 - Math.pow(b2, ep));
    w[j] -= lrNow * mh / (Math.sqrt(vh) + eps);
  }
  if (ep % 100 === 0 || ep === epochs) {
    const lt = loss(w, K, false), lv = loss(w, K, true);
    if (lv < bestVal) { bestVal = lv; bestW = Float64Array.from(w); }
    console.log(`epoch ${ep}: latih ${lt.toExponential(4)} validasi ${lv.toExponential(4)} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
}

// Skala TIDAK diubah (K tetap dari bobot awal): margin pemangkasan di search
// dikalibrasi untuk skala "satu pion ~ 100cp", jadi skala itu harus dipertahankan.
const params = E.exportParams(bestW);
const mat = params;
console.log('materi (mg/eg):', [1, 2, 3, 4, 5].map(t => 'pnbrq'[t - 1] + '=' + mat['material[' + t + ']'].join('/')).join(' '));
for (const nm of ['doubled', 'isolated', 'backward', 'bishopPair', 'rookOpen', 'rookSemiOpen', 'tempo', 'kingDangerScale', 'kingOpenFile', 'threatRookOnQueen'])
  console.log('  ' + nm + ': ' + params[nm].join('/'));
if (write) {
  fs.writeFileSync(E.PARAMS_FILE, JSON.stringify(params, null, 0).replace(/\],/g, '],\n') + '\n');
  console.log('ditulis ke ' + E.PARAMS_FILE);
}
