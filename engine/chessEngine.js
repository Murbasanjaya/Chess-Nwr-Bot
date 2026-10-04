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
 * @param {object} [opts]     { sanHistory, nodeLimit, classMargin }
 */
function findBestMoves(fen, maxDepth, budgetMs, opts) {
  opts = opts || {};
  const pos = newPosition(fen, opts.sanHistory);
  const res = searcher.searchRoot(pos, {
    maxDepth: maxDepth || 64,
    budgetMs: budgetMs == null ? 1500 : budgetMs,
    nodeLimit: opts.nodeLimit,
    classMargin: opts.classMargin,
  });
  const verbose = mapToVerbose(fen, res.rootMoves.map(r => r.move));
  const scored = [];
  for (let i = 0; i < res.rootMoves.length; i++) {
    if (!verbose[i]) continue; // seharusnya nggak kejadian; aman-aman saja
    scored.push({ m: verbose[i], s: res.rootMoves[i].score });
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
// Angka depth di sini realistis buat engine baru: depth 8 cuma butuh ~0,5 detik,
// jadi level atas bisa mikir 14–30 langkah ke depan dalam waktu 1–3 detik.
//
//   maxDepth : batas kedalaman
//   budget   : jatah waktu (ms) — ini yang biasanya jadi penentu
//   blunder  : peluang sengaja main langkah jelek (biar level bawah manusiawi)
//   top      : ambil acak dari N langkah terbaik
//   noise    : toleransi centipawn — langkah yang selisihnya di bawah ini
//              dianggap "sama bagus" dan boleh dipilih acak
function eloConfig(elo) {
  if (elo < 700)  return { maxDepth: 2,  budget: 60,   blunder: .42,  top: 6, noise: 220, tag: 'Pemula — asal jalan, sering blunder' };
  if (elo < 1000) return { maxDepth: 3,  budget: 100,  blunder: .26,  top: 5, noise: 150, tag: 'Santai — mikir sebentar, kadang meleset' };
  if (elo < 1300) return { maxDepth: 5,  budget: 160,  blunder: .15,  top: 4, noise: 90,  tag: 'Menengah — sesekali meleset' };
  if (elo < 1600) return { maxDepth: 7,  budget: 260,  blunder: .075, top: 3, noise: 55,  tag: 'Cukup kuat — jarang blunder' };
  if (elo < 1900) return { maxDepth: 9,  budget: 420,  blunder: .035, top: 2, noise: 35,  tag: 'Kuat — menghitung taktik beberapa langkah' };
  if (elo < 2200) return { maxDepth: 11, budget: 700,  blunder: .012, top: 2, noise: 22,  tag: 'Ahli — jeli baca kombinasi' };
  if (elo < 2600) return { maxDepth: 14, budget: 1100, blunder: 0,    top: 1, noise: 12,  tag: 'Master — mengincar celah taktik & kombinasi menang' };
  if (elo < 3200) return { maxDepth: 18, budget: 1600, blunder: 0,    top: 1, noise: 6,   tag: 'Grandmaster — menghitung dalam, memburu skakmat' };
  if (elo < 4000) return { maxDepth: 24, budget: 2200, blunder: 0,    top: 1, noise: 0,   tag: 'Super GM — sangat sulit dikalahkan' };
  return { maxDepth: 48, budget: 3000, blunder: 0, top: 1, noise: 0, tag: 'Maksimal — menghitung sangat dalam, mengejar skakmat begitu ada celah' };
}

/**
 * Pilih langkah dari daftar hasil search sesuai level.
 *
 * Bedanya dengan versi lama: kalau level bawah "salah langkah", dia nggak
 * langsung ambil langkah terburuk di papan (itu kelihatan aneh/nggak manusiawi),
 * tapi langkah yang rugi sekitar 1–4 bidak — tipe kesalahan yang beneran
 * dilakukan pemain. Skakmat paksa tetap selalu dimainkan.
 */
function pickMove(scored, cfg) {
  if (!scored || scored.length === 0) return -1;
  if (scored.length === 1) return 0;
  if (scored[0].s >= MATE_THRESHOLD) return 0;      // skakmat ketemu: jangan main-main
  if (scored[0].s <= -MATE_THRESHOLD) return 0;     // sudah kalah paksa: ambil yang paling lama

  if (cfg.blunder > 0 && Math.random() < cfg.blunder) {
    // kesalahan "manusiawi": rugi 80–450 cp kalau ada pilihan seperti itu
    const best = scored[0].s;
    const pool = [];
    for (let i = 1; i < scored.length; i++) {
      const loss = best - scored[i].s;
      if (loss >= 80 && loss <= 450) pool.push(i);
    }
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    // nggak ada pilihan "agak jelek": ambil dari paruh bawah
    const start = Math.max(1, Math.ceil(scored.length / 2));
    return Math.min(scored.length - 1, start + Math.floor(Math.random() * Math.max(1, scored.length - start)));
  }

  // langkah-langkah yang praktis sama bagusnya: pilih acak biar nggak monoton
  const limit = Math.max(1, Math.min(cfg.top || 1, scored.length));
  let n = 1;
  while (n < limit && scored[0].s - scored[n].s <= (cfg.noise || 0)) n++;
  return Math.floor(Math.random() * n);
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
    const second = res.rootMoves.length > 1 ? res.rootMoves[1].score : res.score;
    gap = res.score - second;
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
  const gap = isBest ? best - (scored.length > 1 ? scored[1].s : best) : 0;
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
  eloConfig, pickMove, classifyMove, gradePlayedMove, qualityFromLoss,
  detectOpening, bookMove, pieceValueOf, BOOK_PLY_LIMIT, OPENINGS,
  MATE, MATE_THRESHOLD,
  Position, Searcher, searcher,
};
