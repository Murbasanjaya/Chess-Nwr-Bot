'use strict';
// ============================================================================
// evaluate.js — fungsi evaluasi posisi (penilaian "siapa yang lebih enak").
//
// Versi lama cuma: materi + satu piece-square table + pion dobel/yatim/lolos +
// pasangan gajah. Versi ini jauh lebih "ngerti catur":
//
//   * TAPERED EVAL — tiap bidak punya dua tabel: midgame & endgame, lalu
//     dicampur sesuai sisa materi di papan. Jadi raja tahu harus sembunyi di
//     awal permainan, tapi harus maju ke tengah di endgame; pion tahu dia makin
//     berharga pas bidak lain udah habis.
//   * Struktur pion lengkap: dobel, yatim, terbelakang, pion lolos (dinilai per
//     baris + apakah diblokir + jarak raja di endgame), pion bersambung/phalanx.
//   * Mobilitas tiap bidak (tidak menghitung kotak yang dijaga pion musuh).
//   * Keamanan raja: tameng pion, file terbuka ke arah raja, dan bobot serangan
//     musuh ke "zona raja".
//   * Benteng di file terbuka/semi-terbuka & di baris ke-7, kuda di outpost,
//     pasangan gajah, bonus tempo.
//   * Penyesuaian endgame: materi tak cukup buat menang (skala turun) dan
//     dorongan menggiring raja musuh ke pojok biar skakmat dasar beneran kelar.
// ============================================================================

const P = require('./position.js');
const {
  PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
  mkPiece, onBoard, fileOf, rankOf, sq64,
  KNIGHT_OFF, BISHOP_OFF, ROOK_OFF, KING_OFF,
} = P;

// ---------------- nilai materi (midgame / endgame) ----------------
const MG_VAL = new Int32Array([0, 82, 337, 365, 477, 1025, 0]);
const EG_VAL = new Int32Array([0, 94, 281, 297, 512, 936, 0]);
// nilai "rata-rata" yang dipakai di luar eval (ordering, klasifikasi, SEE)
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// ---------------- piece-square tables ----------------
// Ditulis seperti papan sungguhan: baris pertama = baris ke-8 (sisi hitam),
// kolom kiri = file a. Lebih enak dibaca/diedit. Nanti di-flip ke indeks
// internal (indeks 0 = a1) sama fungsi flip() di bawah.
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

// ---------------- bobot istilah-istilah evaluasi ----------------
const PHASE_W = new Int32Array([0, 0, 1, 1, 2, 4, 0]);
const TOTAL_PHASE = 24;

const DOUBLED_MG = -11, DOUBLED_EG = -28;
const ISOLATED_MG = -14, ISOLATED_EG = -16;
const BACKWARD_MG = -8, BACKWARD_EG = -10;
const PHALANX_MG = 6, PHALANX_EG = 4;
const SUPPORTED_MG = 8, SUPPORTED_EG = 6;
// bonus pion lolos per baris (dari sisi pemiliknya; indeks = baris 0..7)
const PASSED_MG = new Int32Array([0, 2, 6, 18, 36, 66, 110, 0]);
const PASSED_EG = new Int32Array([0, 12, 22, 44, 78, 130, 190, 0]);

const BISHOP_PAIR_MG = 26, BISHOP_PAIR_EG = 48;
const ROOK_OPEN_MG = 26, ROOK_OPEN_EG = 12;
const ROOK_SEMI_MG = 12, ROOK_SEMI_EG = 6;
const ROOK_7TH_MG = 14, ROOK_7TH_EG = 28;
const OUTPOST_MG = 22, OUTPOST_EG = 10;
const TEMPO_MG = 14, TEMPO_EG = 6;
const KNIGHT_PAWN_ADJ = 3;   // kuda makin kuat kalau pion masih banyak
const BISHOP_PAWN_PEN = -4;  // gajah tersumbat pion sendiri sewarna

// mobilitas: bobot per kotak & "titik netral" biar nilainya nggak meledak
const MOB_MG = new Int32Array([0, 0, 4, 4, 3, 1, 0]);
const MOB_EG = new Int32Array([0, 0, 4, 5, 5, 2, 0]);
const MOB_BASE = new Int32Array([0, 0, 4, 6, 7, 14, 0]);

// bobot serangan ke zona raja per jenis bidak penyerang
const KING_ATT_W = new Int32Array([0, 0, 2, 2, 3, 5, 0]);
// Tabel bahaya raja. Indeksnya dihitung dari JUMLAH BIDAK penyerang (masing-masing
// dihitung sekali, pakai bobot di atas) + jumlah kotak zona yang terserang.
// Dulu tiap kotak serangan dihitung penuh, dan nilainya jadi meledak sampai
// ratusan centipawn — posisi seimbang kebaca "menang telak".
const KING_DANGER = new Int32Array(100);
for (let i = 0; i < 100; i++) KING_DANGER[i] = Math.min(400, Math.round((i * i) / 4.2));
const SHIELD_PEN = [0, -2, -14, -26];   // penalti per pion tameng yang hilang (by jarak)
const KING_OPEN_FILE_PEN = -22;

// jarak ke tengah papan (buat menggiring raja musuh ke pojok di endgame)
const CENTER_DIST = new Int32Array(64);
for (let i = 0; i < 64; i++) {
  const r = i >> 3, f = i & 7;
  CENTER_DIST[i] = Math.max(Math.abs(r * 2 - 7), Math.abs(f * 2 - 7)) >> 1;
}

// zona raja: kotak raja + 8 tetangganya (lookup O(1) lewat tabel 16KB).
// Jangan dibikin lebih lebar: zona yang kelewat besar bikin hitungan serangan
// membengkak dan nilai keamanan raja jadi mendominasi seluruh evaluasi.
const IN_ZONE = new Uint8Array(128 * 128);
(function initZone() {
  for (let ks = 0; ks < 128; ks++) {
    if (!onBoard(ks)) continue;
    const kr = rankOf(ks), kf = fileOf(ks);
    for (let s = 0; s < 128; s++) {
      if (!onBoard(s)) continue;
      const dr = Math.abs(rankOf(s) - kr), df = Math.abs(fileOf(s) - kf);
      if (df <= 1 && dr <= 1) IN_ZONE[ks * 128 + s] = 1;
    }
  }
})();

function sqDist(a, b) {
  return Math.max(Math.abs(rankOf(a) - rankOf(b)), Math.abs(fileOf(a) - fileOf(b)));
}

// ---------------- scratch (dipakai ulang, nol alokasi per evaluasi) ----------------
const pawnFiles = [new Int32Array(8), new Int32Array(8)];
const pawnMinRank = [new Int32Array(8), new Int32Array(8)]; // baris terkecil per file
const pawnMaxRank = [new Int32Array(8), new Int32Array(8)]; // baris terbesar per file
const pawnAtt = [new Uint8Array(128), new Uint8Array(128)];

/**
 * Evaluasi posisi. Hasil selalu dari sudut pandang PUTIH (positif = putih enak),
 * sama seperti absoluteEval() versi lama, biar gampang dibandingkan.
 */
function evaluate(pos) {
  const board = pos.board;
  let mg = 0, eg = 0, phase = 0;

  // ---- siapkan peta pion dulu (dipakai hampir semua istilah di bawah) ----
  for (let c = 0; c < 2; c++) {
    pawnFiles[c].fill(0);
    pawnMinRank[c].fill(8);
    pawnMaxRank[c].fill(-1);
    pawnAtt[c].fill(0);
    const code = mkPiece(PAWN, c);
    const cnt = pos.pieceCount[code];
    for (let i = 0; i < cnt; i++) {
      const s = pos.pieceList[code * 16 + i];
      const f = fileOf(s), r = rankOf(s);
      pawnFiles[c][f]++;
      if (r < pawnMinRank[c][f]) pawnMinRank[c][f] = r;
      if (r > pawnMaxRank[c][f]) pawnMaxRank[c][f] = r;
      const up = c === WHITE ? 16 : -16;
      const a1 = s + up - 1, a2 = s + up + 1;
      if (onBoard(a1)) pawnAtt[c][a1] = 1;
      if (onBoard(a2)) pawnAtt[c][a2] = 1;
    }
  }

  const pawnsTotal = pos.pieceCount[mkPiece(PAWN, WHITE)] + pos.pieceCount[mkPiece(PAWN, BLACK)];
  const kingSqW = pos.kingSq[WHITE], kingSqB = pos.kingSq[BLACK];
  const kingZoneBase = [kingSqW * 128, kingSqB * 128];
  const attWeight = [0, 0], attCount = [0, 0], zoneAtt = [0, 0];

  // ---- jalan-jalan ke semua bidak lewat daftar bidak (bukan nyapu 64 kotak) ----
  for (let c = 0; c < 2; c++) {
    const them = c ^ 1;
    const sign = c === WHITE ? 1 : -1;
    const enemyZone = kingZoneBase[them];
    let bishops = 0, lightBishop = 0, darkBishop = 0;

    for (let t = PAWN; t <= KING; t++) {
      const code = mkPiece(t, c);
      const cnt = pos.pieceCount[code];
      const mgT = MG_PST[t], egT = EG_PST[t];
      for (let i = 0; i < cnt; i++) {
        const s = pos.pieceList[code * 16 + i];
        const idx = c === WHITE ? sq64(s) : (sq64(s) ^ 56);
        phase += PHASE_W[t];
        mg += sign * (MG_VAL[t] + mgT[idx]);
        eg += sign * (EG_VAL[t] + egT[idx]);

        const f = fileOf(s), r = rankOf(s);
        const relRank = c === WHITE ? r : 7 - r;

        if (t === PAWN) {
          // --- struktur pion ---
          if (pawnFiles[c][f] > 1) { mg += sign * DOUBLED_MG; eg += sign * DOUBLED_EG; }
          const hasLeft = f > 0 && pawnFiles[c][f - 1] > 0;
          const hasRight = f < 7 && pawnFiles[c][f + 1] > 0;
          if (!hasLeft && !hasRight) { mg += sign * ISOLATED_MG; eg += sign * ISOLATED_EG; }
          // dijaga pion sendiri?
          if (pawnAtt[c][s]) { mg += sign * SUPPORTED_MG; eg += sign * SUPPORTED_EG; }
          // berdampingan (phalanx)
          if ((f > 0 && board[s - 1] === code) || (f < 7 && board[s + 1] === code)) {
            mg += sign * PHALANX_MG; eg += sign * PHALANX_EG;
          }
          // terbelakang: nggak bisa dijaga pion tetangga lagi & kotak depannya dijaga pion musuh
          const up = c === WHITE ? 16 : -16;
          if (!pawnAtt[c][s] && onBoard(s + up) && pawnAtt[them][s + up]) {
            const behindLeft = f > 0 && pawnFiles[c][f - 1] > 0 &&
              (c === WHITE ? pawnMinRank[c][f - 1] < r : pawnMaxRank[c][f - 1] > r);
            const behindRight = f < 7 && pawnFiles[c][f + 1] > 0 &&
              (c === WHITE ? pawnMinRank[c][f + 1] < r : pawnMaxRank[c][f + 1] > r);
            if (!behindLeft && !behindRight) { mg += sign * BACKWARD_MG; eg += sign * BACKWARD_EG; }
          }
          // --- pion lolos (passed pawn) ---
          let passed = true;
          for (let df = -1; df <= 1; df++) {
            const nf = f + df;
            if (nf < 0 || nf > 7) continue;
            if (pawnFiles[them][nf] === 0) continue;
            if (c === WHITE) { if (pawnMaxRank[them][nf] > r) { passed = false; break; } }
            else { if (pawnMinRank[them][nf] < r) { passed = false; break; } }
          }
          if (passed) {
            let pmg = PASSED_MG[relRank], peg = PASSED_EG[relRank];
            // diblokir bidak musuh di depannya? nilainya turun
            const front = s + up;
            if (onBoard(front) && board[front]) { pmg = (pmg * 2 / 3) | 0; peg = (peg * 2 / 3) | 0; }
            // di endgame, yang penting raja siapa yang lebih dekat ke kotak promosi
            const promoSq = (c === WHITE ? 7 : 0) * 16 + f;
            const myK = c === WHITE ? kingSqW : kingSqB;
            const opK = c === WHITE ? kingSqB : kingSqW;
            peg += (sqDist(opK, promoSq) - sqDist(myK, promoSq)) * (relRank + 1) * 2;
            mg += sign * pmg; eg += sign * peg;
          }
        } else if (t === KNIGHT) {
          // kuda: mobilitas + outpost + makin berguna kalau pion masih rame
          let mob = 0, zoneHits = 0;
          for (let k = 0; k < 8; k++) {
            const to = s + KNIGHT_OFF[k];
            if (!onBoard(to)) continue;
            if (IN_ZONE[enemyZone + to]) zoneHits++;
            const p = board[to];
            if (p && ((p >> 3) & 1) === c) continue;
            if (pawnAtt[them][to]) continue;
            mob++;
          }
          if (zoneHits) { attCount[c]++; attWeight[c] += KING_ATT_W[KNIGHT]; zoneAtt[c] += zoneHits; }
          mg += sign * (MOB_MG[KNIGHT] * (mob - MOB_BASE[KNIGHT]) + KNIGHT_PAWN_ADJ * (pawnsTotal - 8));
          eg += sign * MOB_EG[KNIGHT] * (mob - MOB_BASE[KNIGHT]);
          if (relRank >= 3 && relRank <= 5 && pawnAtt[c][s] && !pawnAtt[them][s]) {
            mg += sign * OUTPOST_MG; eg += sign * OUTPOST_EG;
          }
        } else if (t === BISHOP || t === ROOK || t === QUEEN) {
          const offs = t === BISHOP ? BISHOP_OFF : (t === ROOK ? ROOK_OFF : KING_OFF);
          const nOff = t === ROOK ? 4 : (t === BISHOP ? 4 : 8);
          let mob = 0, zoneHits = 0;
          for (let k = 0; k < nOff; k++) {
            const off = offs[k];
            let to = s + off;
            while (onBoard(to)) {
              const p = board[to];
              if (IN_ZONE[enemyZone + to]) zoneHits++;
              if (p) {
                if (((p >> 3) & 1) !== c && !pawnAtt[them][to]) mob++;
                break;
              }
              if (!pawnAtt[them][to]) mob++;
              to += off;
            }
          }
          if (zoneHits) { attCount[c]++; attWeight[c] += KING_ATT_W[t]; zoneAtt[c] += zoneHits; }
          mg += sign * MOB_MG[t] * (mob - MOB_BASE[t]);
          eg += sign * MOB_EG[t] * (mob - MOB_BASE[t]);
          if (t === BISHOP) {
            bishops++;
            if (((f + r) & 1) === 0) darkBishop++; else lightBishop++;
            // gajah kehalang pion sendiri yang sewarna kotaknya
            let blockers = 0;
            const pcode = mkPiece(PAWN, c);
            const pcnt = pos.pieceCount[pcode];
            for (let j = 0; j < pcnt; j++) {
              const ps = pos.pieceList[pcode * 16 + j];
              if (((fileOf(ps) + rankOf(ps)) & 1) === ((f + r) & 1)) blockers++;
            }
            mg += sign * BISHOP_PAWN_PEN * blockers;
            eg += sign * BISHOP_PAWN_PEN * blockers;
          } else if (t === ROOK) {
            if (pawnFiles[c][f] === 0) {
              if (pawnFiles[them][f] === 0) { mg += sign * ROOK_OPEN_MG; eg += sign * ROOK_OPEN_EG; }
              else { mg += sign * ROOK_SEMI_MG; eg += sign * ROOK_SEMI_EG; }
            }
            if (relRank === 6) { mg += sign * ROOK_7TH_MG; eg += sign * ROOK_7TH_EG; }
          }
        }
      }
    }
    if (bishops >= 2 && lightBishop >= 1 && darkBishop >= 1) {
      mg += sign * BISHOP_PAIR_MG; eg += sign * BISHOP_PAIR_EG;
    }
  }

  // ---- keamanan raja (hanya kerasa di midgame; otomatis luntur di endgame) ----
  for (let c = 0; c < 2; c++) {
    const sign = c === WHITE ? 1 : -1;
    const them = c ^ 1;
    const ks = c === WHITE ? kingSqW : kingSqB;
    const kf = fileOf(ks), kr = rankOf(ks);
    // tameng pion di tiga file sekitar raja
    for (let df = -1; df <= 1; df++) {
      const f = kf + df;
      if (f < 0 || f > 7) continue;
      if (pawnFiles[c][f] === 0) {
        mg += sign * KING_OPEN_FILE_PEN;
      } else {
        const nearest = c === WHITE ? pawnMinRank[c][f] : pawnMaxRank[c][f];
        const dist = Math.abs(nearest - kr);
        mg += sign * SHIELD_PEN[Math.min(3, dist)];
      }
    }
    // bobot serangan musuh ke zona raja: butuh minimal dua bidak penyerang —
    // satu bidak sendirian nggak bikin raja beneran repot
    if (attCount[them] >= 2) {
      const w = Math.min(99, attWeight[them] * 2 + zoneAtt[them]);
      mg -= sign * KING_DANGER[w];
    }
  }

  // ---- tempo: yang jalan dapat sedikit bonus ----
  const tempoSign = pos.side === WHITE ? 1 : -1;
  mg += tempoSign * TEMPO_MG; eg += tempoSign * TEMPO_EG;

  // ---- campur midgame & endgame sesuai sisa materi ----
  if (phase > TOTAL_PHASE) phase = TOTAL_PHASE;
  let score = ((mg * phase) + (eg * (TOTAL_PHASE - phase))) / TOTAL_PHASE;

  // ---- penyesuaian endgame ----
  score = endgameAdjust(pos, score, phase);
  return score | 0;
}

// Dua hal yang bikin endgame nggak ngaco:
//  1) kalau materi nggak cukup buat menang, nilainya dikecilin (jangan ngejar
//     "keunggulan" yang sebenarnya seri)
//  2) kalau lawan cuma raja doang, dorong raja musuh ke pojok & dekatkan raja
//     sendiri — ini yang bikin skakmat dasar (raja+menteri, raja+benteng) beneran
//     kelar, bukan muter-muter sampai aturan 50 langkah
function endgameAdjust(pos, score, phase) {
  const pawnsW = pos.pieceCount[mkPiece(PAWN, WHITE)], pawnsB = pos.pieceCount[mkPiece(PAWN, BLACK)];
  const strong = score > 0 ? WHITE : BLACK;
  const weak = strong ^ 1;
  const strongPawns = strong === WHITE ? pawnsW : pawnsB;

  const weakPieces = pos.pieceCount[mkPiece(KNIGHT, weak)] + pos.pieceCount[mkPiece(BISHOP, weak)] +
    pos.pieceCount[mkPiece(ROOK, weak)] + pos.pieceCount[mkPiece(QUEEN, weak)] +
    (weak === WHITE ? pawnsW : pawnsB);

  if (strongPawns === 0) {
    const strongMat = pos.pieceCount[mkPiece(KNIGHT, strong)] * 320 + pos.pieceCount[mkPiece(BISHOP, strong)] * 330 +
      pos.pieceCount[mkPiece(ROOK, strong)] * 500 + pos.pieceCount[mkPiece(QUEEN, strong)] * 900;
    const weakMat = pos.pieceCount[mkPiece(KNIGHT, weak)] * 320 + pos.pieceCount[mkPiece(BISHOP, weak)] * 330 +
      pos.pieceCount[mkPiece(ROOK, weak)] * 500 + pos.pieceCount[mkPiece(QUEEN, weak)] * 900;
    // tanpa pion & selisih materi kurang dari satu benteng: biasanya seri
    if (strongMat - weakMat < 400) score = (score / 4) | 0;
  }

  if (weakPieces === 0 && phase <= 8) {
    // lawan tinggal raja: giring ke pojok, rapatkan raja sendiri
    const wk = pos.kingSq[weak], sk = pos.kingSq[strong];
    const drive = CENTER_DIST[sq64(wk)] * 14 + (7 - sqDist(sk, wk)) * 10;
    score += (strong === WHITE ? drive : -drive);
  }
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

module.exports = { evaluate, absoluteEval, VAL, MG_VAL, EG_VAL, PHASE_W, TOTAL_PHASE };
