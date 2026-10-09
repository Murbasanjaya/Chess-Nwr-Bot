'use strict';
// Kalibrasi Elo: ukur kekuatan tiap titik s (0..1) lewat pertandingan nyata.
//
//   node test/tools/calibrate.js [partai-per-putaran] [--write] [--fresh] [--report]
//   (--report: cuma hitung ulang tabel dari log, tanpa main)
//
// Jangkar: Stockfish dengan UCI_LimitStrength + UCI_Elo (rentang resmi
// 1320–3190; tim Stockfish mengkalibrasi skala ini terhadap daftar CCRL).
// Titik yang lebih lemah dari jangkauan itu diukur melawan titik kita sendiri
// yang sudah terkalibrasi (rantai Elo).
//
// Tiap titik bisa dimainkan beberapa putaran (lawan disesuaikan kalau skornya
// terlalu jomplang). Elo akhirnya = performance rating maximum-likelihood dari
// SEMUA partai titik itu, bukan cuma putaran terakhir. Hasil mentah disimpan di
// test/tools/calibration-log.json, jadi prosesnya bisa dilanjutkan kalau terputus.
const fs = require('fs');
const path = require('path');
const { run, fmt } = require('./gauntlet.js');

const games = parseInt(process.argv[2] || '60', 10);
const write = process.argv.includes('--write');
const S_LIST = [1.0, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0.0, -0.25, -0.5];
const SF_MIN = 1320, SF_MAX = 3190;
const LOG = path.join(__dirname, 'calibration-log.json');
const OUT = path.join(__dirname, '..', '..', 'engine', 'elo-calibration.json');

let log = {};
if (fs.existsSync(LOG) && !process.argv.includes('--fresh')) log = JSON.parse(fs.readFileSync(LOG, 'utf8'));

// Performance rating MLE: cari E supaya total skor harapan = total skor nyata.
// Rentang ketidakpastian dari informasi Fisher (pakai varians skor per partai
// yang teramati, jadi remis ikut diperhitungkan).
function performance(runs) {
  const games = [];
  for (const r of runs) {
    for (let i = 0; i < r.w; i++) games.push([r.anchorElo, 1]);
    for (let i = 0; i < r.d; i++) games.push([r.anchorElo, 0.5]);
    for (let i = 0; i < r.l; i++) games.push([r.anchorElo, 0]);
  }
  const n = games.length;
  const total = games.reduce((a, g) => a + g[1], 0);
  const exp = E => games.reduce((a, g) => a + 1 / (1 + Math.pow(10, (g[0] - E) / 400)), 0);
  // skor sempurna/nol: geser sedikit biar MLE-nya tetap berhingga
  const target = Math.min(n - 0.5, Math.max(0.5, total));
  let lo = -1000, hi = 5000;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (exp(mid) < target) lo = mid; else hi = mid; }
  const E = (lo + hi) / 2;
  const mean = total / n;
  const varScore = games.reduce((a, g) => a + (g[1] - mean) * (g[1] - mean), 0) / n;
  const slope = games.reduce((a, g) => { const p = 1 / (1 + Math.pow(10, (g[0] - E) / 400)); return a + p * (1 - p) * Math.LN10 / 400; }, 0);
  const se = Math.sqrt(n * Math.max(varScore, 0.05)) / slope;
  return { elo: E, lo: E - 1.96 * se, hi: E + 1.96 * se, games: n, score: mean };
}

function save() { fs.writeFileSync(LOG, JSON.stringify(log, null, 1) + '\n'); }

(async () => {
  let guess = 2400;
  const reportOnly = process.argv.includes('--report');
  for (const s of (reportOnly ? [] : S_LIST)) {
    const key = String(s);
    log[key] = log[key] || [];
    for (let round = log[key].length; round < 3; round++) {
      if (round > 0) {
        const last = log[key][log[key].length - 1];
        const sc = (last.w + last.d / 2) / (last.w + last.d + last.l);
        const atLimit = last.anchorType === 'sf' && ((sc > 0.85 && last.anchorElo >= SF_MAX) || (sc < 0.15 && last.anchorElo <= SF_MIN));
        if ((sc >= 0.15 && sc <= 0.85) || atLimit) break; // sudah informatif
        guess = performance(log[key]).elo;
      }
      let anchor;
      if (guess >= SF_MIN + 50) {
        const e = Math.max(SF_MIN, Math.min(SF_MAX, Math.round(guess / 10) * 10));
        anchor = { spec: { type: 'sf', elo: e, ms: 100 }, elo: e, type: 'sf', name: 'Stockfish UCI_Elo ' + e };
      } else {
        // di bawah jangkauan Stockfish: lawan titik kita sendiri yang Elo-nya terdekat
        const known = Object.keys(log).filter(k => k !== key && log[k].length)
          .map(k => ({ s: parseFloat(k), elo: performance(log[k]).elo }));
        const ref = known.sort((a, b) => Math.abs(a.elo - guess) - Math.abs(b.elo - guess))[0];
        anchor = { spec: { type: 'ours', s: ref.s }, elo: Math.round(ref.elo), type: 'ours', name: 'engine s=' + ref.s + ' (~' + Math.round(ref.elo) + ')' };
      }
      const r = await run({ a: JSON.stringify({ type: 'ours', s }), b: JSON.stringify(anchor.spec), games: String(games), seed: String(7 + round) });
      log[key].push({ anchorElo: anchor.elo, anchorType: anchor.type, anchor: anchor.name, w: r.w, d: r.d, l: r.l });
      save();
      console.log(`s=${s} vs ${anchor.name}: ${fmt(r)}`);
    }
    const p = performance(log[key]);
    console.log(`==> s=${s}: Elo ${Math.round(p.elo)} [${Math.round(p.lo)} .. ${Math.round(p.hi)}] dari ${p.games} partai`);
    guess = p.elo - 200;
  }

  // Ketidakpastian titik yang dirantai ke titik engine sendiri harus ikut
  // menanggung ketidakpastian jangkarnya (jangkar Stockfish = definisi skala,
  // jadi dianggap pasti). Diproses dari titik terkuat ke terlemah, urutan yang
  // sama dengan urutan pengukurannya.
  const seOf = {};
  const points = [];
  for (const s of S_LIST) {
    const runs = log[String(s)];
    if (!runs || !runs.length) continue;
    const p = performance(runs);
    const seMatch = (p.hi - p.lo) / 3.92;
    let anchorSe = 0;
    for (const r of runs) {
      if (r.anchorType !== 'ours') continue;
      const m = /s=(-?[\d.]+)/.exec(r.anchor);
      const n = r.w + r.d + r.l;
      anchorSe += (n / p.games) * (m && seOf[m[1]] !== undefined ? seOf[m[1]] : 0);
    }
    const se = Math.sqrt(seMatch * seMatch + anchorSe * anchorSe);
    seOf[String(s)] = se;
    points.push({ s, elo: Math.round(p.elo), lo: Math.round(p.elo - 1.96 * se), hi: Math.round(p.elo + 1.96 * se),
      games: p.games, anchors: runs.map(r => r.anchor + ` (${r.w}M ${r.d}S ${r.l}K)`) });
  }
  points.sort((a, b) => a.s - b.s);
  const out = {
    scale: 'UCI_Elo Stockfish 19 (skala yang dikalibrasi tim Stockfish ke daftar CCRL) — BUKAN rating FIDE/chess.com/lichess',
    method: `pertandingan melawan Stockfish ber-UCI_Elo (movetime 100ms), ${games} partai per putaran, pembuka seimbang dari buku (warna ditukar); ` +
      `Elo = performance rating maximum-likelihood dari semua partai; titik di bawah ${SF_MIN} dirantai ke titik engine sendiri`,
    date: new Date().toISOString().slice(0, 10),
    points,
  };
  console.log(JSON.stringify(out, null, 1));
  if (write) { fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n'); console.log('ditulis ke ' + OUT); }
})();
