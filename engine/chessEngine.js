'use strict';
// ============================================================================
// chessEngine.js — "muka" engine yang dipakai server.js.
//
// Otak sebenarnya ada di tiga file:
//   engine/position.js   — papan cepat (0x88), movegen, Zobrist, make/unmake, SEE
//   engine/evaluate.js   — evaluasi posisi (tapered: midgame + endgame)
//   engine/search.js     — negamax + alpha-beta + semua teknik pemangkasan
//
// File ini yang ngurus: terjemahan ke/dari chess.js (biar bentuk objek langkahnya
// sama persis seperti sebelumnya buat frontend), buku pembukaan, level Elo,
// pemilihan langkah, dan klasifikasi kualitas langkah.
//
// Tetap bukan Stockfish — semua kode pencarian & evaluasi di repo ini buatan
// sendiri. chess.js cuma dipakai di batas API (validasi + penulisan SAN), nggak
// pernah masuk ke dalam loop pencarian.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');
const OPENINGS = require('../data/openings.js');
const P = require('./position.js');
const EV = require('./evaluate.js');
const { Searcher, MATE, MATE_IN_MAX } = require('./search.js');

const { Position, MFROM, MTO, MPROMO, algebraic, PIECE_CHAR } = P;
const { evaluate, absoluteEval, VAL } = EV;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Satu Searcher dipakai terus-menerus: tabel transposisi, killer, dan history
// jadi "ingatan" yang kebawa dari langkah ke langkah. Hasilnya, langkah kedua
// dan seterusnya di satu partai jauh lebih cepat sampai kedalaman yang sama.
// Node single-thread & pencarian ini sinkron, jadi request nggak akan tumpang
// tindih di tengah pencarian.
const searcher = new Searcher();

// Skor di atas ini artinya skakmat paksa sudah ketemu.
const MATE_THRESHOLD = MATE_IN_MAX;

function pieceValueOf(type) { return VAL[type] || 0; }

// ---------------- jembatan ke chess.js ----------------
function uciOf(m) {
  let s = algebraic(MFROM(m)) + algebraic(MTO(m));
  const p = MPROMO(m);
  if (p) s += PIECE_CHAR[p];
  return s;
}

// Petakan langkah internal (integer) ke objek verbose chess.js, biar bentuk
// datanya persis sama seperti versi lama (ada .san, .flags, .piece, dll).
function mapToVerbose(fen, internalMoves) {
  const legal = new Chess(fen).moves({ verbose: true });
  const byKey = new Map();
  for (const lm of legal) byKey.set(lm.from + lm.to + (lm.promotion || ''), lm);
  const out = [];
  for (const im of internalMoves) {
    const v = byKey.get(uciOf(im));
    out.push(v || null);
  }
  return out;
}

// Riwayat posisi dari daftar SAN, supaya engine tahu posisi apa saja yang sudah
// pernah muncul (deteksi ulangan/seri yang benar).
function buildHistoryEntries(sanHistory) {
  if (!Array.isArray(sanHistory) || sanHistory.length === 0) return null;
  try {
    const g = new Chess();
    const tmp = new Position();
    const entries = [];
    tmp.setFen(START_FEN);
    entries.push([tmp.keyA, tmp.keyB, 1]);
    for (const san of sanHistory) {
      const mv = g.move(san, { sloppy: true });
      if (!mv) return null;
      tmp.setFen(g.fen());
      // halfmove clock 0 = langkah tak bisa diulang (pion maju / makan)
      entries.push([tmp.keyA, tmp.keyB, tmp.halfmove === 0 ? 1 : 0]);
    }
    entries.pop(); // posisi terakhir = posisi sekarang, sudah ada sendiri
    return { entries, fen: g.fen() };
  } catch (e) {
    return null;
  }
}

function newPosition(fen, sanHistory) {
  const pos = new Position().setFen(fen);
  const hist = buildHistoryEntries(sanHistory);
  if (hist && hist.fen.split(' ').slice(0, 4).join(' ') === fen.split(' ').slice(0, 4).join(' ')) {
    pos.seedHistory(hist.entries);
  }
  return pos;
}

// ---------------- API utama ----------------
/**
 * Cari langkah terbaik, plus skor SEMUA langkah legal di posisi itu.
 *
 * Bentuk hasilnya sengaja dibuat sama seperti versi lama: array
 * [{ m: <objek langkah chess.js>, s: <skor centipawn> }] urut dari terbaik,
 * jadi server.js & klasifikasi langkah nggak perlu diubah.
 *
 * @param {string} fen        posisi
 * @param {number} maxDepth   batas kedalaman (search tetap dibatasi waktu juga)
 * @param {number} budgetMs   jatah waktu mikir
 * @param {object} [opts]     { sanHistory, nodeLimit, classMargin, gradeBudgetMs }
 */
function findBestMoves(fen, maxDepth, budgetMs, opts) {
  opts = opts || {};
  const pos = newPosition(fen, opts.sanHistory);
  const res = searcher.searchRoot(pos, {
    maxDepth: maxDepth || 64,
    budgetMs: budgetMs == null ? 1500 : budgetMs,
    nodeLimit: opts.nodeLimit,
    classMargin: opts.classMargin,
    gradeBudgetMs: opts.gradeBudgetMs,
    gradeNodes: opts.gradeNodes,
  });
  const verbose = mapToVerbose(fen, res.rootMoves.map(r => r.move));
  const scored = [];
  for (let i = 0; i < res.rootMoves.length; i++) {
    if (!verbose[i]) continue; // seharusnya nggak kejadian; aman-aman saja
    scored.push({ m: verbose[i], s: res.rootMoves[i].score, exact: res.rootMoves[i].exact });
  }
  scored.info = {
    depth: res.depth, seldepth: res.seldepth, nodes: res.nodes,
    timeMs: res.timeMs, mate: res.mate,
    nps: res.timeMs > 0 ? Math.round(res.nodes / res.timeMs * 1000) : 0,
    pv: mapToVerbose(fen, res.pv.length ? [res.pv[0]] : []).filter(Boolean).map(v => v.san),
  };
  return scored;
}

/** Analisis lengkap satu posisi (dipakai endpoint /api/analyze). */
function analyze(fen, opts) {
  opts = opts || {};
  const pos = newPosition(fen, opts.sanHistory);
  const res = searcher.searchRoot(pos, {
    maxDepth: opts.maxDepth || 64,
    budgetMs: opts.budgetMs == null ? 1200 : opts.budgetMs,
    classMargin: opts.classMargin,
  });
  const pvVerbose = [];
  {
    // tulis PV dalam SAN dengan menelusuri posisinya pakai chess.js
    const g = new Chess(fen);
    for (const im of res.pv) {
      const legal = g.moves({ verbose: true });
      const want = uciOf(im);
      const found = legal.find(l => (l.from + l.to + (l.promotion || '')) === want);
      if (!found) break;
      g.move(found);
      pvVerbose.push(found.san);
    }
  }
  const verbose = mapToVerbose(fen, res.best ? [res.best] : [])[0] || null;
  return {
    best: verbose,
    score: res.score,
    mate: res.mate,
    depth: res.depth,
    seldepth: res.seldepth,
    nodes: res.nodes,
    timeMs: res.timeMs,
    nps: res.timeMs > 0 ? Math.round(res.nodes / res.timeMs * 1000) : 0,
    pv: pvVerbose,
    eval: evaluate(pos),
  };
}

/** Cari langkah internal (integer) yang cocok dengan {from,to,promotion}. */
function internalMoveOf(pos, move) {
  const want = move.from + move.to + (move.promotion || '');
  const n = pos.generate(0, false);
  for (let i = 0; i < n; i++) {
    const m = pos.moveBuf[i];
    if (uciOf(m) === want) return m;
  }
  return 0;
}

/** Static exchange evaluation buat satu langkah (dipakai badge "Brilian"). */
function seeOfMove(fen, move) {
  try {
    const pos = new Position().setFen(fen);
    const m = internalMoveOf(pos, move);
    return m ? pos.see(m) : 0;
  } catch (e) { /* abaikan */ }
  return 0;
}

// ---------------- level kekuatan (Elo) ----------------
// Kekuatan bot diatur lewat SATU angka kontinu s (0 = paling lemah, 1 = penuh):
//
//   nodes   : batas jumlah posisi yang boleh dihitung per langkah. Sengaja
//             pakai node, BUKAN waktu: dengan batas waktu, bot di HP lambat
//             jadi jauh lebih lemah daripada di server kencang, dan angka Elo
//             apa pun jadi nggak bermakna. Dengan node, kekuatannya sama di
//             semua perangkat (yang beda cuma lama mikirnya).
//   noise   : "derau" pemilihan langkah (centipawn). Langkah yang selisihnya
//             dengan langkah terbaik masih di dalam derau ini bisa terpilih.
//   blunder : peluang sengaja bikin kesalahan "manusiawi" (rugi 1-4 pion).
//
// Hubungan s <-> Elo TIDAK ditebak: diukur lewat ratusan partai melawan
// Stockfish yang dibatasi Elo-nya (UCI_Elo resmi, skala ~CCRL), lalu disimpan
// di engine/elo-calibration.json oleh test/tools/calibrate.js.
const MAX_NODES = 500000;
const MIN_NODES = 150;

// s negatif (sampai S_MIN) = level ekstra lemah buat pemula: node tetap minimum,
// derau & peluang blunder dinaikkan. Rumus buat s >= 0 sengaja nggak diubah
// supaya titik-titik yang sudah dikalibrasi tetap berlaku.
const S_MIN = -0.5;

function strengthParams(s) {
  s = Math.max(S_MIN, Math.min(1, s));
  const nodes = Math.round(MIN_NODES * Math.pow(MAX_NODES / MIN_NODES, Math.max(0, s)));
  let noise = s >= 0.9 ? 0 : Math.round(300 * Math.pow((0.9 - s) / 0.9, 1.7));
  let blunder = s >= 0.5 ? 0 : +(0.25 * Math.pow((0.5 - s) / 0.5, 1.5)).toFixed(4);
  if (s < 0) {
    const t = s / S_MIN; // 0..1
    noise = Math.round(300 + 400 * t);
    blunder = +(0.25 + 0.30 * t).toFixed(4);
  }
  return {
    s, nodes, noise, blunder,
    maxDepth: 64,
    // batas waktu cuma jaring pengaman (HP yang sangat lambat); penentunya node
    // (asumsi perangkat paling lambat ~30rb node/detik)
    budget: Math.round(Math.min(8000, Math.max(250, nodes / 30))),
    // resolusi penilaian langkah harus mencakup rentang derau
    classMargin: Math.max(240, 2 * noise + 150),
  };
}

const CALIBRATION_FILE = path.join(__dirname, 'elo-calibration.json');
// Titik cadangan kalau file kalibrasi belum ada (perkiraan kasar, bukan hasil ukur).
let CALIBRATION = { measured: false, points: [{ s: 0, elo: 700 }, { s: 1, elo: 2300 }] };
try {
  const c = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
  if (Array.isArray(c.points) && c.points.length >= 2) CALIBRATION = Object.assign({ measured: true }, c);
} catch (e) { /* belum dikalibrasi: pakai cadangan */ }
// pastikan monoton naik (s naik -> Elo naik), buat interpolasi balik yang aman
CALIBRATION.points.sort((a, b) => a.s - b.s);
for (let i = 1; i < CALIBRATION.points.length; i++) {
  if (CALIBRATION.points[i].elo <= CALIBRATION.points[i - 1].elo) CALIBRATION.points[i].elo = CALIBRATION.points[i - 1].elo + 1;
}
const ELO_MIN = Math.ceil(CALIBRATION.points[0].elo / 50) * 50;
const ELO_MAX = Math.floor(CALIBRATION.points[CALIBRATION.points.length - 1].elo / 50) * 50;

function strengthForElo(elo) {
  const pts = CALIBRATION.points;
  if (elo <= pts[0].elo) return pts[0].s;
  for (let i = 1; i < pts.length; i++) {
    if (elo <= pts[i].elo) {
      const a = pts[i - 1], b = pts[i];
      return a.s + (b.s - a.s) * (elo - a.elo) / (b.elo - a.elo);
    }
  }
  return pts[pts.length - 1].s;
}

const ELO_BANDS = [
  [1000, 'Pemula — sering membiarkan bidak dimakan'],
  [1300, 'Santai — taktik sederhana kadang terlewat'],
  [1600, 'Menengah — jarang blunder, masih kecolongan taktik'],
  [1900, 'Kuat — menghitung kombinasi pendek dengan rapi'],
  [2200, 'Ahli — jeli baca kombinasi, main posisional'],
  [2500, 'Master — sangat sulit dikalahkan manusia'],
  [null, 'Maksimal — kekuatan penuh engine ini'],
];
function eloTag(elo) {
  for (const [below, tag] of ELO_BANDS) if (below === null || elo < below) return tag;
  return '';
}

function eloConfig(elo) {
  const e = Math.max(ELO_MIN, Math.min(ELO_MAX, Number(elo) || 1200));
  const p = strengthParams(strengthForElo(e));
  return Object.assign(p, { elo: e, tag: eloTag(e) });
}

function eloInfo() {
  return {
    min: ELO_MIN, max: ELO_MAX, step: 50,
    measured: !!CALIBRATION.measured,
    scale: CALIBRATION.scale || null,
    date: CALIBRATION.date || null,
    bands: ELO_BANDS.map(([below, tag]) => ({ below, tag })),
  };
}

/** Cari & pilih langkah bot untuk satu level (cfg dari eloConfig/strengthParams). */
function botSearch(fen, cfg, sanHistory) {
  const scored = findBestMoves(fen, cfg.maxDepth, cfg.budget, {
    sanHistory, nodeLimit: cfg.nodes, classMargin: cfg.classMargin,
    // Penilaian langkah lain juga dibatasi node (bukan waktu) supaya level
    // yang butuh skor semua langkah (derau/blunder) tetap sama kuatnya di
    // perangkat apa pun. Level tanpa derau cuma butuh skor itu buat badge,
    // jadi jatahnya kecil — bot jadi lebih cepat jalan.
    gradeBudgetMs: cfg.budget,
    gradeNodes: (cfg.noise > 0 || cfg.blunder > 0) ? cfg.nodes : Math.min(cfg.nodes, 40000),
  });
  const idx = pickMove(scored, cfg);
  return { scored, idx };
}

/**
 * Pilih langkah dari daftar hasil search sesuai level.
 *
 *  - Skakmat paksa selalu dimainkan.
 *  - Dengan peluang `blunder`: kesalahan "manusiawi" — langkah yang rugi
 *    sekitar 1–5 pion (bukan langkah terburuk di papan, itu nggak natural).
 *  - Selain itu: tiap langkah dapat skor + derau acak (0..noise), yang
 *    tertinggi dipilih. Langkah yang jauh lebih jelek dari derau nggak pernah
 *    terpilih; makin kecil derau, makin sering langkah terbaik yang keluar.
 */
function pickMove(scored, cfg) {
  if (!scored || scored.length === 0) return -1;
  if (scored.length === 1) return 0;
  if (scored[0].s >= MATE_THRESHOLD) return 0;
  if (scored[0].s <= -MATE_THRESHOLD) return 0;
  const best = scored[0].s;

  if (cfg.blunder > 0 && Math.random() < cfg.blunder) {
    const pool = [];
    for (let i = 1; i < scored.length; i++) {
      if (scored[i].exact === false) continue; // ruginya belum diketahui
      const loss = best - scored[i].s;
      if (loss >= 100 && loss <= 500) pool.push(i);
    }
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  }

  const noise = cfg.noise || 0;
  if (noise <= 0) return 0;
  let bi = 0, bv = -Infinity;
  for (let i = 0; i < scored.length; i++) {
    if (best - scored[i].s > noise) break; // daftar terurut: sisanya pasti kalah
    // Langkah yang belum sempat dinilai tuntas nggak boleh ikut diundi:
    // skornya cuma perkiraan kasar dan bisa menyembunyikan blunder.
    if (scored[i].exact === false) continue;
    const v = scored[i].s + noise * Math.random();
    if (v > bv) { bv = v; bi = i; }
  }
  return bi;
}

// ---------------- klasifikasi kualitas langkah ----------------
const BOOK_TAG = { tier: 'book', label: 'Buku', chip: '📖' };

// Ambang batas penilaian, dipakai bareng oleh dua jalur klasifikasi di bawah.
//   loss  = seberapa banyak centipawn yang hilang dibanding langkah terbaik
//   gap   = selisih langkah terbaik ke langkah terbaik kedua
//   see   = static exchange evaluation langkahnya (negatif = mengorbankan materi)
function qualityFromLoss(loss, isBest, gap, see) {
  if (isBest) {
    // "Brilian": langkah terbaik yang MENGORBANKAN materi tapi tetap jauh lebih
    // baik dari langkah lain — korban sungguhan, bukan sekadar tukar bidak biasa
    // (deteksi versi lama kecolongan di sini: tukar gajah biasa pun kebaca brilian).
    if (gap >= 60 && see <= -120) return { tier: 'brilliant', label: 'Brilian', chip: '💎' };
    if (gap >= 180) return { tier: 'great', label: 'Hebat', chip: '⭐' };
    return { tier: 'best', label: 'Terbaik', chip: '✓' };
  }
  if (loss < 45) return { tier: 'good', label: 'Baik', chip: '✓' };
  if (loss < 110) return { tier: 'inacc', label: 'Kurang Tepat', chip: '?!' };
  if (loss < 260) return { tier: 'mistake', label: 'Salah', chip: '?' };
  return { tier: 'blunder', label: 'BAD', chip: '??' };
}

/**
 * Nilai satu langkah yang BARU dimainkan — ini yang dipakai buat badge kualitas
 * langkah pemain.
 *
 * Caranya beda (dan jauh lebih akurat) daripada sekadar melihat peringkat
 * langkah di daftar hasil search: posisi sebelum langkah dicari sampai
 * kedalaman D, lalu posisi SESUDAH langkah dicari lagi sampai kedalaman yang
 * sama dengan jendela penuh. Dua angka dari kedalaman yang sama, jadi
 * "kerugian"-nya beneran berarti.
 *
 * @param {string} fenBefore posisi sebelum langkah
 * @param {object} move      {from, to, promotion}
 * @param {object} [opts]    { plyNumber, maxDepth, budgetMs, sanHistoryBefore }
 */
function gradePlayedMove(fenBefore, move, opts) {
  opts = opts || {};
  const plyNumber = opts.plyNumber || 0;
  if (plyNumber <= 6) return { tag: BOOK_TAG, loss: 0, depth: 0, bestScore: 0, playedScore: 0, best: null };

  const maxDepth = opts.maxDepth || 64;
  const budgetMs = opts.budgetMs == null ? 300 : opts.budgetMs;

  const pos = newPosition(fenBefore, opts.sanHistoryBefore);
  const res = searcher.searchRoot(pos, {
    maxDepth, budgetMs, gradeAll: true, classMargin: 320,
    // Jangan pakai plafon waktu bawaan di sini: kedalamannya sudah tetap, dan
    // badge kualitas langkah harus bisa diulang — langkah yang sama mesti dapat
    // badge yang sama, bukan berubah gara-gara servernya pas lebih sibuk.
    gradeBudgetMs: budgetMs,
  });
  if (!res.best) return { tag: { tier: 'good', label: 'Baik', chip: '✓' }, loss: 0, depth: 0, bestScore: 0, playedScore: 0, best: null };

  const wantUci = move.from + move.to + (move.promotion || '');
  const isBest = uciOf(res.best) === wantUci;
  const bestVerbose = mapToVerbose(fenBefore, [res.best])[0] || null;
  let loss = 0, gap = 0, playedScore = res.score;

  if (isBest) {
    const second = res.rootMoves.find((r, i) => i > 0 && r.exact);
    gap = second ? res.score - second.score : 0;
  } else {
    const pos2 = newPosition(fenBefore, opts.sanHistoryBefore);
    const m = internalMoveOf(pos2, move);
    if (m && pos2.makeMove(m)) {
      const childDepth = Math.max(1, res.depth - 1);
      const r2 = searcher.searchRoot(pos2, {
        maxDepth: childDepth, budgetMs: Math.max(80, budgetMs), gradeAll: false,
      });
      pos2.unmakeMove();
      playedScore = -r2.score;
    } else {
      // langkahnya nggak ketemu (seharusnya nggak kejadian) — pakai daftar hasil search
      const row = res.rootMoves.find(r => uciOf(r.move) === wantUci);
      playedScore = row ? row.score : res.score;
    }
    loss = res.score - playedScore;
    if (loss < 0) loss = 0;
  }

  const see = isBest ? seeOfMove(fenBefore, move) : 0;
  return {
    tag: qualityFromLoss(loss, isBest, gap, see),
    loss, gap, isBest, see,
    bestScore: res.score, playedScore,
    best: bestVerbose,
    depth: res.depth,
    mate: res.mate,
  };
}

// Klasifikasi dari daftar hasil search (dipakai buat langkah bot sendiri, yang
// daftar skornya sudah ada dari pencarian yang sama).
function classifyMove(scored, playedIdx, plyNumber, fenBefore) {
  if (plyNumber <= 6) return BOOK_TAG;
  if (!scored || !scored.length) return { tier: 'good', label: 'Baik', chip: '✓' };
  if (playedIdx < 0 || playedIdx >= scored.length) playedIdx = scored.length - 1;
  const best = scored[0].s;
  const isBest = playedIdx === 0;
  const loss = best - scored[playedIdx].s;
  const second = scored.find((x, i) => i > 0 && x.exact !== false);
  const gap = isBest ? (second ? best - second.s : 0) : 0;
  const see = (isBest && fenBefore) ? seeOfMove(fenBefore, scored[0].m) : 0;
  return qualityFromLoss(loss, isBest, gap, see);
}

// ---------------- buku pembukaan ----------------
// history: array SAN dari langkah pertama, misal ['e4','e5','Nf3']
function detectOpening(history) {
  let bestMatch = null;
  for (const entry of OPENINGS) {
    if (entry.moves.length > history.length) continue;
    let match = true;
    for (let i = 0; i < entry.moves.length; i++) { if (entry.moves[i] !== history[i]) { match = false; break; } }
    if (match && (!bestMatch || entry.moves.length > bestMatch.moves.length)) bestMatch = entry;
  }
  return bestMatch ? { eco: bestMatch.eco, name: bestMatch.name, counter: bestMatch.counter } : null;
}

const BOOK_PLY_LIMIT = 14; // berhenti pakai buku setelah sebanyak ini setengah-langkah
function bookMove(history) {
  if (history.length >= BOOK_PLY_LIMIT) return null;
  const candidates = [];
  for (const entry of OPENINGS) {
    if (entry.moves.length <= history.length) continue;
    let match = true;
    for (let i = 0; i < history.length; i++) { if (entry.moves[i] !== history[i]) { match = false; break; } }
    if (match) candidates.push(entry.moves[history.length]);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)]; // string SAN
}

module.exports = {
  Chess, VAL, absoluteEval, evaluate,
  findBestMoves, analyze, seeOfMove,
  eloConfig, eloInfo, strengthParams, botSearch, strengthForElo, pickMove, classifyMove, gradePlayedMove, qualityFromLoss,
  ELO_MIN, ELO_MAX, CALIBRATION_FILE,
  detectOpening, bookMove, pieceValueOf, BOOK_PLY_LIMIT, OPENINGS,
  MATE, MATE_THRESHOLD,
  Position, Searcher, searcher,
};
