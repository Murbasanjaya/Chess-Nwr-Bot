'use strict';
// ============================================================================
// evaluate.js — fungsi evaluasi posisi (penilaian "siapa yang lebih enak").
//
// Semua bobot evaluasi tinggal di SATU array parameter (W), berpasangan
// [midgame, endgame]. Ini yang memungkinkan bobotnya di-tuning secara numerik:
// test/tools/tune.js mencocokkan ratusan bobot ini dengan penilaian Stockfish
// di ratusan ribu posisi (metode Texel). Stockfish cuma jadi "guru" waktu
// tuning — engine ini sendiri nggak pernah memanggil Stockfish.
//
// Isi evaluasinya:
//   * TAPERED EVAL — tiap fitur punya nilai midgame & endgame yang dicampur
//     sesuai sisa materi di papan.
//   * Materi + piece-square table per bidak.
//   * Struktur pion: dobel, yatim, terbelakang, phalanx & pion dijaga (per
//     baris), pion lolos (per baris, diblokir/jalan bebas, jarak raja).
//   * Mobilitas per jumlah kotak (tabel, bukan garis lurus).
//   * Keamanan raja: tameng pion, file terbuka, bobot serangan ke zona raja.
//   * Ancaman: bidak diserang pion / bidak yang lebih murah, bidak menggantung.
//   * Benteng di file terbuka/semi-terbuka & baris ke-7, outpost kuda & gajah,
//     pasangan gajah, kuda vs jumlah pion, gajah tersumbat pion sendiri, tempo.
//   * Penyesuaian endgame: materi tak cukup buat menang + menggiring raja
//     musuh ke pojok biar skakmat dasar beneran kelar.
//
// Mode "jejak" (trace): evaluateTrace() mencatat koefisien tiap parameter.
// Karena evaluasinya linear terhadap W (selain beberapa bagian kecil yang
// dicatat terpisah), tuner bisa menghitung gradien persis tanpa evaluasi ulang.
// ============================================================================

const fs = require('fs');
const path = require('path');
const P = require('./position.js');
const {
  PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
  mkPiece, onBoard, fileOf, rankOf, sq64,
  KNIGHT_OFF, BISHOP_OFF, ROOK_OFF, KING_OFF,
} = P;

// nilai "rata-rata" yang dipakai di luar eval (ordering, klasifikasi, SEE)
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// ---------------- nilai awal (sebelum tuning) ----------------
const MG_VAL = [0, 82, 337, 365, 477, 1025, 0];
const EG_VAL = [0, 94, 281, 297, 512, 936, 0];

// ---------------- piece-square tables (nilai awal) ----------------
// Ditulis seperti papan sungguhan: baris pertama = baris ke-8, kolom kiri = file a.
function flip(vis) {
  const t = new Int32Array(64);
  for (let i = 0; i < 64; i++) t[(7 - (i >> 3)) * 8 + (i & 7)] = vis[i];
  return t;
}

const MG_PST = [null,
  flip([   0,   0,   0,   0,   0,   0,   0,   0,
          98, 134,  61,  95,  68, 126,  34, -11,
          -6,   7,  26,  31,  65,  56,  25, -20,
         -14,  13,   6,  21,  23,  12,  17, -23,
         -27,  -2,  -5,  12,  17,   6,  10, -25,
         -26,  -4,  -4, -10,   3,   3,  33, -12,
         -35,  -1, -20, -23, -15,  24,  38, -22,
           0,   0,   0,   0,   0,   0,   0,   0]),
  flip([-167, -89, -34, -49,  61, -97, -15,-107,
         -73, -41,  72,  36,  23,  62,   7, -17,
         -47,  60,  37,  65,  84, 129,  73,  44,
          -9,  17,  19,  53,  37,  69,  18,  22,
         -13,   4,  16,  13,  28,  19,  21,  -8,
         -23,  -9,  12,  10,  19,  17,  25, -16,
         -29, -53, -12,  -3,  -1,  18, -14, -19,
        -105, -21, -58, -33, -17, -28, -19, -23]),
  flip([ -29,   4, -82, -37, -25, -42,   7,  -8,
         -26,  16, -18, -13,  30,  59,  18, -47,
         -16,  37,  43,  40,  35,  50,  37,  -2,
          -4,   5,  19,  50,  37,  37,   7,  -2,
          -6,  13,  13,  26,  34,  12,  10,   4,
           0,  15,  15,  15,  14,  27,  18,  10,
           4,  15,  16,   0,   7,  21,  33,   1,
         -33,  -3, -14, -21, -13, -12, -39, -21]),
  flip([  32,  42,  32,  51,  63,   9,  31,  43,
          27,  32,  58,  62,  80,  67,  26,  44,
          -5,  19,  26,  36,  17,  45,  61,  16,
         -24, -11,   7,  26,  24,  35,  -8, -20,
         -36, -26, -12,  -1,   9,  -7,   6, -23,
         -45, -25, -16, -17,   3,   0,  -5, -33,
         -44, -16, -20,  -9,  -1,  11,  -6, -71,
         -19, -13,   1,  17,  16,   7, -37, -26]),
  flip([ -28,   0,  29,  12,  59,  44,  43,  45,
         -24, -39,  -5,   1, -16,  57,  28,  54,
         -13, -17,   7,   8,  29,  56,  47,  57,
         -27, -27, -16, -16,  -1,  17,  -2,   1,
          -9, -26,  -9, -10,  -2,  -4,   3,  -3,
         -14,   2, -11,  -2,  -5,   2,  14,   5,
         -35,  -8,  11,   2,   8,  15,  -3,   1,
          -1, -18,  -9,  10, -15, -25, -31, -50]),
  flip([ -65,  23,  16, -15, -56, -34,   2,  13,
          29,  -1, -20,  -7,  -8,  -4, -38, -29,
          -9,  24,   2, -16, -20,   6,  22, -22,
         -17, -20, -12, -27, -30, -25, -14, -36,
         -49,  -1, -27, -39, -46, -44, -33, -51,
         -14, -14, -22, -46, -44, -30, -15, -27,
           1,   7,  -8, -64, -43, -16,   9,   8,
         -15,  36,  12, -54,   8, -28,  24,  14]),
];

const EG_PST = [null,
  flip([   0,   0,   0,   0,   0,   0,   0,   0,
         178, 173, 158, 134, 147, 132, 165, 187,
          94, 100,  85,  67,  56,  53,  82,  84,
          32,  24,  13,   5,  -2,   4,  17,  17,
          13,   9,  -3,  -7,  -7,  -8,   3,  -1,
           4,   7,  -6,   1,   0,  -5,  -1,  -8,
          13,   8,   8,  10,  13,   0,   2,  -7,
           0,   0,   0,   0,   0,   0,   0,   0]),
  flip([ -58, -38, -13, -28, -31, -27, -63, -99,
         -25,  -8, -25,  -2,  -9, -25, -24, -52,
         -24, -20,  10,   9,  -1,  -9, -19, -41,
         -17,   3,  22,  22,  22,  11,   8, -18,
         -18,  -6,  16,  25,  16,  17,   4, -18,
         -23,  -3,  -1,  15,  10,  -3, -20, -22,
         -42, -20, -10,  -5,  -2, -20, -23, -44,
         -29, -51, -23, -15, -22, -18, -50, -64]),
  flip([ -14, -21, -11,  -8,  -7,  -9, -17, -24,
          -8,  -4,   7, -12,  -3, -13,  -4, -14,
           2,  -8,   0,  -1,  -2,   6,   0,   4,
          -3,   9,  12,   9,  14,  10,   3,   2,
          -6,   3,  13,  19,   7,  10,  -3,  -9,
         -12,  -3,   8,  10,  13,   3,  -7, -15,
         -14, -18,  -7,  -1,   4,  -9, -15, -27,
         -23,  -9, -23,  -5,  -9, -16,  -5, -17]),
  flip([  13,  10,  18,  15,  12,  12,   8,   5,
          11,  13,  13,  11,  -3,   3,   8,   3,
           7,   7,   7,   5,   4,  -3,  -5,  -3,
           4,   3,  13,   1,   2,   1,  -1,   2,
           3,   5,   8,   4,  -5,  -6,  -8, -11,
          -4,   0,  -5,  -1,  -7, -12,  -8, -16,
          -6,  -6,   0,   2,  -9,  -9, -11,  -3,
          -9,   2,   3,  -1,  -5, -13,   4, -20]),
  flip([  -9,  22,  22,  27,  27,  19,  10,  20,
         -17,  20,  32,  41,  58,  25,  30,   0,
         -20,   6,   9,  49,  47,  35,  19,   9,
           3,  22,  24,  45,  57,  40,  57,  36,
         -18,  28,  19,  47,  31,  34,  39,  23,
         -16, -27,  15,   6,   9,  17,  10,   5,
         -22, -23, -30, -16, -16, -23, -36, -32,
         -33, -28, -22, -43,  -5, -32, -20, -41]),
  flip([ -74, -35, -18, -18, -11,  15,   4, -17,
         -12,  17,  14,  17,  17,  38,  23,  11,
          10,  17,  23,  15,  20,  45,  44,  13,
          -8,  22,  24,  27,  26,  33,  26,   3,
         -18,  -4,  21,  24,  27,  23,   9, -11,
         -19,  -3,  11,  21,  23,  16,   7,  -9,
         -27, -11,   4,  13,  14,   4,  -5, -17,
         -53, -34, -21, -11, -28, -14, -24, -43]),
];


// ---------------- registri parameter ----------------
// Tiap parameter = sepasang angka [mg, eg] di W[2k], W[2k+1]. Indeks k-nya
// disimpan di konstanta K_* di bawah. Nama dipakai buat menyimpan/memuat hasil
// tuning (eval-params.json), jadi urutan boleh berubah tanpa merusak file itu.
const NAMES = [];
const DEFAULTS = [];
function def(name, mg, eg) {
  const k = NAMES.length;
  NAMES.push(name); DEFAULTS.push(Math.round(mg), Math.round(eg));
  return k;
}
function defArr(name, n, fn) {
  const base = NAMES.length;
  for (let i = 0; i < n; i++) { const v = fn(i); def(name + '[' + i + ']', v[0], v[1]); }
  return base;
}

const PASSED_MG0 = [0, 2, 6, 18, 36, 66, 110, 0];
const PASSED_EG0 = [0, 12, 22, 44, 78, 130, 190, 0];
const SHIELD0 = [0, -2, -14, -26];

const K_MAT = defArr('material', 7, i => [MG_VAL[i], EG_VAL[i]]);
const K_PST = defArr('pst', 7 * 64, i => {
  const t = i >> 6, s = i & 63;
  return t >= 1 && t <= 6 ? [MG_PST[t][s], EG_PST[t][s]] : [0, 0];
});
const K_DOUBLED = def('doubled', -11, -28);
const K_ISOLATED = def('isolated', -14, -16);
const K_BACKWARD = def('backward', -8, -10);
const K_PHALANX = defArr('phalanx', 8, () => [6, 4]);
const K_SUPPORTED = defArr('supported', 8, () => [8, 6]);
const K_PASSED = defArr('passed', 8, r => [PASSED_MG0[r], PASSED_EG0[r]]);
const K_PASSED_BLOCKED = defArr('passedBlocked', 8, r => [-PASSED_MG0[r] / 3, -PASSED_EG0[r] / 3]);
const K_PASSED_FREE = defArr('passedFree', 8, () => [0, 0]);
const K_PASSED_KDIST = def('passedKingDist', 0, 2);
const K_BISHOP_PAIR = def('bishopPair', 26, 48);
const K_ROOK_OPEN = def('rookOpen', 26, 12);
const K_ROOK_SEMI = def('rookSemiOpen', 12, 6);
const K_ROOK_7TH = def('rook7th', 14, 28);
const K_OUTPOST_N = def('outpostKnight', 22, 10);
const K_OUTPOST_B = def('outpostBishop', 10, 5);
const K_TEMPO = def('tempo', 14, 6);
const K_KNIGHT_PAWNS = def('knightPawns', 3, 0);
const K_BISHOP_BLOCKED = def('bishopBlockedByPawns', -4, -4);
// mobilitas: tabel per jumlah kotak yang bisa didatangi dengan aman
const K_MOB = [0, 0,
  defArr('mobKnight', 9, c => [4 * (c - 4), 4 * (c - 4)]),
  defArr('mobBishop', 14, c => [4 * (c - 6), 5 * (c - 6)]),
  defArr('mobRook', 15, c => [3 * (c - 7), 5 * (c - 7)]),
  defArr('mobQueen', 28, c => [1 * (c - 14), 2 * (c - 14)]),
];
const MOB_MAX = [0, 0, 8, 13, 14, 27];
const K_SHIELD = defArr('kingShield', 4, d => [SHIELD0[d], 0]);
const K_KING_OPEN = def('kingOpenFile', -22, 0);
const K_KING_DANGER = def('kingDangerScale', 64, 0); // dibagi 64
// ancaman (indeks = jenis bidak korban)
const K_THREAT_PAWN = defArr('threatByPawn', 7, t => (t >= KNIGHT && t <= QUEEN) ? [48, 32] : [0, 0]);
const K_THREAT_MINOR = defArr('threatByMinor', 7, t => (t >= ROOK && t <= QUEEN) ? [36, 26] : [0, 0]);
const K_THREAT_ROOK_Q = def('threatRookOnQueen', 36, 26);
const K_HANGING = defArr('hanging', 7, t => (t >= PAWN && t <= QUEEN) ? [8, 8] : [0, 0]);

const NPARAMS = NAMES.length;
// Bobot yang aktif dipakai engine. Diisi nilai awal, lalu ditimpa hasil tuning
// (eval-params.json) kalau file itu ada.
const W = new Int32Array(NPARAMS * 2);
for (let i = 0; i < W.length; i++) W[i] = DEFAULTS[i];

function loadParams(obj) {
  let n = 0;
  const idx = new Map(NAMES.map((nm, k) => [nm, k]));
  for (const nm of Object.keys(obj)) {
    const k = idx.get(nm);
    if (k === undefined) continue;
    W[2 * k] = Math.round(obj[nm][0]); W[2 * k + 1] = Math.round(obj[nm][1]);
    n++;
  }
  return n;
}
function exportParams(weights) {
  const w = weights || W, out = {};
  for (let k = 0; k < NPARAMS; k++) out[NAMES[k]] = [Math.round(w[2 * k]), Math.round(w[2 * k + 1])];
  return out;
}
const PARAMS_FILE = path.join(__dirname, 'eval-params.json');
if (fs.existsSync(PARAMS_FILE) && !process.env.CATUR_DEFAULT_EVAL) {
  loadParams(JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')));
}

// ---------------- konstanta struktural (bukan bobot) ----------------
const PHASE_W = new Int32Array([0, 0, 1, 1, 2, 4, 0]);
const TOTAL_PHASE = 24;
const KING_ATT_W = new Int32Array([0, 0, 2, 2, 3, 5, 0]);
// bahaya raja mentah (indeks dari bobot penyerang + kotak zona yang diserang);
// besar akhirnya dikali parameter kingDangerScale/64
const KING_DANGER = new Int32Array(100);
for (let i = 0; i < 100; i++) KING_DANGER[i] = Math.min(400, Math.round((i * i) / 4.2));

const CENTER_DIST = new Int32Array(64);
for (let i = 0; i < 64; i++) {
  const r = i >> 3, f = i & 7;
  CENTER_DIST[i] = Math.max(Math.abs(r * 2 - 7), Math.abs(f * 2 - 7)) >> 1;
}

// zona raja: kotak raja + 8 tetangganya (lookup O(1) lewat tabel 16KB)
const IN_ZONE = new Uint8Array(128 * 128);
(function initZone() {
  for (let ks = 0; ks < 128; ks++) {
    if (!onBoard(ks)) continue;
    const kr = rankOf(ks), kf = fileOf(ks);
    for (let s = 0; s < 128; s++) {
      if (!onBoard(s)) continue;
      if (Math.abs(fileOf(s) - kf) <= 1 && Math.abs(rankOf(s) - kr) <= 1) IN_ZONE[ks * 128 + s] = 1;
    }
  }
})();

function sqDist(a, b) {
  return Math.max(Math.abs(rankOf(a) - rankOf(b)), Math.abs(fileOf(a) - fileOf(b)));
}

// ---------------- scratch (dipakai ulang, nol alokasi per evaluasi) ----------------
// Data pion per warna, datar: indeks c*8 + file
const PF = new Int8Array(16);    // jumlah pion per file
const PMIN = new Int8Array(16);  // baris terkecil per file
const PMAX = new Int8Array(16);  // baris terbesar per file
// Peta serangan datar, indeks c*128 + kotak, isinya bit-flag. Satu array
// (satu fill per evaluasi) jauh lebih murah daripada delapan array terpisah.
const ATT = new Uint8Array(256);
const A_PAWN = 1, A_ANY = 2, A_MINOR = 4, A_ROOK = 8;

// info tambahan dari mode jejak (bagian yang nggak linear terhadap W)
const TRACE_INFO = { phase: 0, scale: 1, extra: 0 };

/**
 * Evaluasi posisi. Hasil selalu dari sudut pandang PUTIH (positif = putih enak).
 */
function evaluate(pos) { return evalCore(pos, null); }

/**
 * Sama seperti evaluate(), tapi juga mengisi T[k] = koefisien parameter k
 * (putih dikurangi hitam). Dipakai tuner. T harus Float64Array(NPARAMS), nol.
 */
function evaluateTrace(pos, T) { return evalCore(pos, T); }

function evalCore(pos, T) {
  const board = pos.board;
  let mg = 0, eg = 0, phase = 0;

  PF.fill(0); PMIN.fill(8); PMAX.fill(-1); ATT.fill(0);
  for (let c = 0; c < 2; c++) {
    const cf = c * 8, cb = c * 128;
    const code = mkPiece(PAWN, c);
    const cnt = pos.pieceCount[code];
    const up = c === WHITE ? 16 : -16;
    for (let i = 0; i < cnt; i++) {
      const s = pos.pieceList[code * 16 + i];
      const f = fileOf(s), r = rankOf(s);
      PF[cf + f]++;
      if (r < PMIN[cf + f]) PMIN[cf + f] = r;
      if (r > PMAX[cf + f]) PMAX[cf + f] = r;
      const a1 = s + up - 1, a2 = s + up + 1;
      if (onBoard(a1)) ATT[cb + a1] |= A_PAWN;
      if (onBoard(a2)) ATT[cb + a2] |= A_PAWN;
    }
    // serangan raja ikut dihitung buat "dijaga/diserang" (bukan buat mobilitas)
    const ks = pos.kingSq[c];
    for (let k = 0; k < 8; k++) { const t = ks + KING_OFF[k]; if (onBoard(t)) ATT[cb + t] |= A_ANY; }
  }

  const pawnsTotal = pos.pieceCount[mkPiece(PAWN, WHITE)] + pos.pieceCount[mkPiece(PAWN, BLACK)];
  const kingSqW = pos.kingSq[WHITE], kingSqB = pos.kingSq[BLACK];
  const attWeight = [0, 0], attCount = [0, 0], zoneAtt = [0, 0];

  for (let c = 0; c < 2; c++) {
    const them = c ^ 1;
    const sign = c === WHITE ? 1 : -1;
    const cf = c * 8, tf = them * 8, cb = c * 128, tb = them * 128;
    const enemyZone = (c === WHITE ? kingSqB : kingSqW) * 128;
    const up = c === WHITE ? 16 : -16;
    let bishops = 0, lightBishop = 0, darkBishop = 0;

    for (let t = PAWN; t <= KING; t++) {
      const code = mkPiece(t, c);
      const cnt = pos.pieceCount[code];
      for (let i = 0; i < cnt; i++) {
        const s = pos.pieceList[code * 16 + i];
        const idx = c === WHITE ? sq64(s) : (sq64(s) ^ 56);
        phase += PHASE_W[t];
        // materi + piece-square table
        let k = K_MAT + t;
        mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
        k = K_PST + t * 64 + idx;
        mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;

        const f = fileOf(s), r = rankOf(s);
        const relRank = c === WHITE ? r : 7 - r;

        if (t === PAWN) {
          if (PF[cf + f] > 1) { k = K_DOUBLED; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign; }
          const hasLeft = f > 0 && PF[cf + f - 1] > 0;
          const hasRight = f < 7 && PF[cf + f + 1] > 0;
          if (!hasLeft && !hasRight) { k = K_ISOLATED; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign; }
          if ((ATT[cb + s] & A_PAWN)) { k = K_SUPPORTED + relRank; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign; }
          if ((f > 0 && board[s - 1] === code) || (f < 7 && board[s + 1] === code)) {
            k = K_PHALANX + relRank; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
          }
          if (!(ATT[cb + s] & A_PAWN) && onBoard(s + up) && (ATT[tb + s + up] & A_PAWN)) {
            const behindLeft = f > 0 && PF[cf + f - 1] > 0 &&
              (c === WHITE ? PMIN[cf + f - 1] < r : PMAX[cf + f - 1] > r);
            const behindRight = f < 7 && PF[cf + f + 1] > 0 &&
              (c === WHITE ? PMIN[cf + f + 1] < r : PMAX[cf + f + 1] > r);
            if (!behindLeft && !behindRight) { k = K_BACKWARD; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign; }
          }
          // pion lolos
          let passed = true;
          for (let df = -1; df <= 1; df++) {
            const nf = f + df;
            if (nf < 0 || nf > 7 || PF[tf + nf] === 0) continue;
            if (c === WHITE ? PMAX[tf + nf] > r : PMIN[tf + nf] < r) { passed = false; break; }
          }
          if (passed) {
            k = K_PASSED + relRank; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
            const front = s + up;
            if (onBoard(front) && board[front]) {
              k = K_PASSED_BLOCKED + relRank; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
            } else {
              let free = true;
              for (let q = front; onBoard(q); q += up) { if (board[q]) { free = false; break; } }
              if (free) { k = K_PASSED_FREE + relRank; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign; }
            }
            const promoSq = (c === WHITE ? 7 : 0) * 16 + f;
            const myK = c === WHITE ? kingSqW : kingSqB, opK = c === WHITE ? kingSqB : kingSqW;
            const coef = (sqDist(opK, promoSq) - sqDist(myK, promoSq)) * (relRank + 1);
            k = K_PASSED_KDIST; mg += sign * coef * W[2 * k]; eg += sign * coef * W[2 * k + 1]; if (T) T[k] += sign * coef;
          }
        } else if (t === KNIGHT) {
          let mob = 0, zoneHits = 0;
          for (let q = 0; q < 8; q++) {
            const to = s + KNIGHT_OFF[q];
            if (!onBoard(to)) continue;
            ATT[cb + to] |= A_ANY | A_MINOR;
            if (IN_ZONE[enemyZone + to]) zoneHits++;
            const p = board[to];
            if (p && ((p >> 3) & 1) === c) continue;
            if ((ATT[tb + to] & A_PAWN)) continue;
            mob++;
          }
          if (zoneHits) { attCount[c]++; attWeight[c] += KING_ATT_W[KNIGHT]; zoneAtt[c] += zoneHits; }
          k = K_MOB[KNIGHT] + mob; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
          const pc = pawnsTotal - 8;
          k = K_KNIGHT_PAWNS; mg += sign * pc * W[2 * k]; eg += sign * pc * W[2 * k + 1]; if (T) T[k] += sign * pc;
          if (relRank >= 3 && relRank <= 5 && (ATT[cb + s] & A_PAWN) && !(ATT[tb + s] & A_PAWN)) {
            k = K_OUTPOST_N; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
          }
        } else if (t === BISHOP || t === ROOK || t === QUEEN) {
          const offs = t === BISHOP ? BISHOP_OFF : (t === ROOK ? ROOK_OFF : KING_OFF);
          const nOff = t === QUEEN ? 8 : 4;
          const attFlag = t === BISHOP ? (A_ANY | A_MINOR) : (t === ROOK ? (A_ANY | A_ROOK) : A_ANY);
          let mob = 0, zoneHits = 0;
          for (let q = 0; q < nOff; q++) {
            const off = offs[q];
            let to = s + off;
            while (onBoard(to)) {
              const p = board[to];
              ATT[cb + to] |= attFlag;
              if (IN_ZONE[enemyZone + to]) zoneHits++;
              if (p) {
                if (((p >> 3) & 1) !== c && !(ATT[tb + to] & A_PAWN)) mob++;
                break;
              }
              if (!(ATT[tb + to] & A_PAWN)) mob++;
              to += off;
            }
          }
          if (zoneHits) { attCount[c]++; attWeight[c] += KING_ATT_W[t]; zoneAtt[c] += zoneHits; }
          if (mob > MOB_MAX[t]) mob = MOB_MAX[t];
          k = K_MOB[t] + mob; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
          if (t === BISHOP) {
            bishops++;
            if (((f + r) & 1) === 0) darkBishop++; else lightBishop++;
            let blockers = 0;
            const pcode = mkPiece(PAWN, c);
            const pcnt = pos.pieceCount[pcode];
            for (let j = 0; j < pcnt; j++) {
              const ps = pos.pieceList[pcode * 16 + j];
              if (((fileOf(ps) + rankOf(ps)) & 1) === ((f + r) & 1)) blockers++;
            }
            k = K_BISHOP_BLOCKED; mg += sign * blockers * W[2 * k]; eg += sign * blockers * W[2 * k + 1]; if (T) T[k] += sign * blockers;
            if (relRank >= 3 && relRank <= 5 && (ATT[cb + s] & A_PAWN) && !(ATT[tb + s] & A_PAWN)) {
              k = K_OUTPOST_B; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
            }
          } else if (t === ROOK) {
            if (PF[cf + f] === 0) {
              k = PF[tf + f] === 0 ? K_ROOK_OPEN : K_ROOK_SEMI;
              mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
            }
            if (relRank === 6) { k = K_ROOK_7TH; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign; }
          }
        }
      }
    }
    if (bishops >= 2 && lightBishop >= 1 && darkBishop >= 1) {
      const k = K_BISHOP_PAIR; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
    }
  }

  // ---- ancaman & bidak menggantung (perlu peta serangan yang sudah lengkap) ----
  for (let c = 0; c < 2; c++) {
    const them = c ^ 1;
    const sign = c === WHITE ? 1 : -1;
    const cb = c * 128, tb = them * 128;
    for (let t = PAWN; t <= QUEEN; t++) {
      const code = mkPiece(t, them);
      const cnt = pos.pieceCount[code];
      for (let i = 0; i < cnt; i++) {
        const s = pos.pieceList[code * 16 + i];
        const a = ATT[cb + s];
        if (!a) continue;
        let k = -1;
        if (t >= KNIGHT && (a & A_PAWN)) k = K_THREAT_PAWN + t;
        else if (t >= ROOK && (a & A_MINOR)) k = K_THREAT_MINOR + t;
        else if (t === QUEEN && (a & A_ROOK)) k = K_THREAT_ROOK_Q;
        if (k >= 0) { mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign; }
        if (ATT[tb + s] === 0) {
          k = K_HANGING + t; mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
        }
      }
    }
  }

  // ---- keamanan raja ----
  for (let c = 0; c < 2; c++) {
    const sign = c === WHITE ? 1 : -1;
    const them = c ^ 1;
    const cf = c * 8;
    const ks = c === WHITE ? kingSqW : kingSqB;
    const kf = fileOf(ks), kr = rankOf(ks);
    for (let df = -1; df <= 1; df++) {
      const f = kf + df;
      if (f < 0 || f > 7) continue;
      let k;
      if (PF[cf + f] === 0) k = K_KING_OPEN;
      else {
        const nearest = c === WHITE ? PMIN[cf + f] : PMAX[cf + f];
        k = K_SHIELD + Math.min(3, Math.abs(nearest - kr));
      }
      mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
    }
    if (attCount[them] >= 2) {
      const raw = KING_DANGER[Math.min(99, attWeight[them] * 2 + zoneAtt[them])];
      const k = K_KING_DANGER;
      mg -= sign * ((raw * W[2 * k]) >> 6); eg -= sign * ((raw * W[2 * k + 1]) >> 6);
      if (T) T[k] -= sign * raw / 64;
    }
  }

  // ---- tempo ----
  {
    const sign = pos.side === WHITE ? 1 : -1, k = K_TEMPO;
    mg += sign * W[2 * k]; eg += sign * W[2 * k + 1]; if (T) T[k] += sign;
  }

  if (phase > TOTAL_PHASE) phase = TOTAL_PHASE;
  let score = ((mg * phase) + (eg * (TOTAL_PHASE - phase))) / TOTAL_PHASE;
  score = endgameAdjust(pos, score, phase, T);
  if (T) TRACE_INFO.phase = phase;
  return score | 0;
}

// Penyesuaian endgame (bagian yang nggak linear terhadap W — dicatat terpisah
// di TRACE_INFO supaya tuner tetap bisa menghitung nilai yang sama persis).
function endgameAdjust(pos, score, phase, T) {
  const pawnsW = pos.pieceCount[mkPiece(PAWN, WHITE)], pawnsB = pos.pieceCount[mkPiece(PAWN, BLACK)];
  const strong = score > 0 ? WHITE : BLACK;
  const weak = strong ^ 1;
  const strongPawns = strong === WHITE ? pawnsW : pawnsB;
  const weakPieces = pos.pieceCount[mkPiece(KNIGHT, weak)] + pos.pieceCount[mkPiece(BISHOP, weak)] +
    pos.pieceCount[mkPiece(ROOK, weak)] + pos.pieceCount[mkPiece(QUEEN, weak)] +
    (weak === WHITE ? pawnsW : pawnsB);
  let scale = 1, extra = 0;
  if (strongPawns === 0) {
    const mat = c => pos.pieceCount[mkPiece(KNIGHT, c)] * 320 + pos.pieceCount[mkPiece(BISHOP, c)] * 330 +
      pos.pieceCount[mkPiece(ROOK, c)] * 500 + pos.pieceCount[mkPiece(QUEEN, c)] * 900;
    // tanpa pion & selisih materi kurang dari satu benteng: biasanya seri
    if (mat(strong) - mat(weak) < 400) { scale = 0.25; score = (score / 4) | 0; }
  }
  if (weakPieces === 0 && phase <= 8) {
    // lawan tinggal raja: giring ke pojok, rapatkan raja sendiri
    const wk = pos.kingSq[weak], sk = pos.kingSq[strong];
    const drive = CENTER_DIST[sq64(wk)] * 14 + (7 - sqDist(sk, wk)) * 10;
    extra = strong === WHITE ? drive : -drive;
    score += extra;
  }
  if (T) { TRACE_INFO.scale = scale; TRACE_INFO.extra = extra; }
  return score;
}

/**
 * Kompatibilitas dengan API lama: absoluteEval() dulu menerima objek chess.js.
 * Sekarang bisa menerima Position, instance chess.js, atau string FEN.
 */
function absoluteEval(x) {
  if (x instanceof P.Position) return evaluate(x);
  const fen = typeof x === 'string' ? x : (x && typeof x.fen === 'function' ? x.fen() : null);
  if (!fen) throw new Error('absoluteEval: butuh Position, instance chess.js, atau FEN');
  return evaluate(new P.Position().setFen(fen));
}

module.exports = {
  evaluate, evaluateTrace, absoluteEval, VAL, PHASE_W, TOTAL_PHASE,
  W, NAMES, NPARAMS, DEFAULTS, TRACE_INFO, loadParams, exportParams, PARAMS_FILE,
};
