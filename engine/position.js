'use strict';
// ============================================================================
// position.js — representasi papan cepat buatan sendiri (0x88 mailbox).
//
// Ini "mesin aturan" internal engine: board, daftar bidak, Zobrist hashing
// incremental, make/unmake move, generator langkah, deteksi serangan, dan SEE.
// Dipisah dari chess.js karena chess.js terlalu berat buat dipakai di dalam
// loop search (alokasi objek tiap langkah + bikin string FEN tiap node).
// chess.js tetap dipakai, tapi cuma di batas API (parsing/validasi/SAN).
//
// Semua angka di sini integer & array-nya typed array — biar JIT-nya V8 bisa
// bikin kode ini jadi mesin yang beneran ngebut.
// ============================================================================

// ---------------- kode bidak & warna ----------------
const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const WHITE = 0, BLACK = 1;

function mkPiece(type, color) { return type | (color << 3); }
function typeOf(p) { return p & 7; }
function colorOf(p) { return (p >> 3) & 1; }

const PIECE_CHAR = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
const CHAR_PIECE = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

// ---------------- geometri 0x88 ----------------
// sq = rank*16 + file; rank 0 = baris 1 (sisi putih). Kotak di luar papan
// ketahuan cuma dengan (sq & 0x88) !== 0 — tanpa cabang perbandingan.
const KNIGHT_OFF = [33, 31, 18, 14, -14, -18, -31, -33];
const BISHOP_OFF = [17, 15, -15, -17];
const ROOK_OFF = [16, 1, -1, -16];
const KING_OFF = [17, 16, 15, 1, -1, -15, -16, -17];

function onBoard(sq) { return (sq & 0x88) === 0; }
function fileOf(sq) { return sq & 7; }
function rankOf(sq) { return sq >> 4; }
function sq64(sq) { return (sq >> 4) * 8 + (sq & 7); }
function algebraic(sq) { return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 4)); }
function fromAlgebraic(s) { return (s.charCodeAt(0) - 97) + (s.charCodeAt(1) - 49) * 16; }

// ---------------- hak castling ----------------
const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;
// tiap kotak yang "kalau disentuh" mencabut hak castling tertentu
const CASTLE_MASK = new Int32Array(128).fill(15);
CASTLE_MASK[0x00] = 15 & ~CASTLE_WQ;   // a1
CASTLE_MASK[0x07] = 15 & ~CASTLE_WK;   // h1
CASTLE_MASK[0x04] = 15 & ~(CASTLE_WK | CASTLE_WQ); // e1
CASTLE_MASK[0x70] = 15 & ~CASTLE_BQ;   // a8
CASTLE_MASK[0x77] = 15 & ~CASTLE_BK;   // h8
CASTLE_MASK[0x74] = 15 & ~(CASTLE_BK | CASTLE_BQ); // e8

// ---------------- encoding langkah (satu int 32-bit) ----------------
// bit  0..7  : kotak asal
// bit  8..15 : kotak tujuan
// bit 16..19 : kode bidak yang dimakan (0 = tidak makan)
// bit 20..23 : tipe bidak hasil promosi (0 = bukan promosi)
// bit 24     : en passant
// bit 25     : castling
// bit 26     : dorong pion dua langkah
const F_EP = 1 << 24, F_CASTLE = 1 << 25, F_DOUBLE = 1 << 26;

function encodeMove(from, to, cap, promo, flags) {
  return (from | (to << 8) | (cap << 16) | (promo << 20) | flags) | 0;
}
function MFROM(m) { return m & 0xff; }
function MTO(m) { return (m >> 8) & 0xff; }
function MCAP(m) { return (m >> 16) & 0xf; }
function MPROMO(m) { return (m >> 20) & 0xf; }
function isEP(m) { return (m & F_EP) !== 0; }
function isCastle(m) { return (m & F_CASTLE) !== 0; }
function isDouble(m) { return (m & F_DOUBLE) !== 0; }
function isCapture(m) { return (m & 0xf0000) !== 0 || (m & F_EP) !== 0; }
function isQuiet(m) { return (m & 0xf0000) === 0 && (m & F_EP) === 0 && (m & 0xf00000) === 0; }
function moveToUci(m) {
  let s = algebraic(MFROM(m)) + algebraic(MTO(m));
  const p = MPROMO(m);
  if (p) s += PIECE_CHAR[p];
  return s;
}

// ---------------- Zobrist (dua kunci 32-bit independen) ----------------
// Satu kunci 32-bit saja terlalu sering tabrakan di tabel transposisi besar,
// jadi kita pakai dua: kunci A buat index, kunci B buat verifikasi.
let rngState = 0x1a2b3c4d;
function rnd32() {
  // xorshift32 — deterministik, jadi hash-nya sama tiap kali server start
  rngState ^= rngState << 13; rngState |= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState |= 0;
  return rngState | 0;
}
const ZOB_PIECE_A = new Int32Array(16 * 128), ZOB_PIECE_B = new Int32Array(16 * 128);
const ZOB_CASTLE_A = new Int32Array(16), ZOB_CASTLE_B = new Int32Array(16);
const ZOB_EP_A = new Int32Array(8), ZOB_EP_B = new Int32Array(8);
let ZOB_SIDE_A = 0, ZOB_SIDE_B = 0;
(function initZobrist() {
  for (let p = 0; p < 16; p++) {
    for (let s = 0; s < 128; s++) { ZOB_PIECE_A[p * 128 + s] = rnd32(); ZOB_PIECE_B[p * 128 + s] = rnd32(); }
  }
  for (let i = 0; i < 16; i++) { ZOB_CASTLE_A[i] = rnd32(); ZOB_CASTLE_B[i] = rnd32(); }
  for (let i = 0; i < 8; i++) { ZOB_EP_A[i] = rnd32(); ZOB_EP_B[i] = rnd32(); }
  ZOB_SIDE_A = rnd32(); ZOB_SIDE_B = rnd32();
})();

// ---------------- nilai bidak buat SEE / move ordering ----------------
const SEE_VAL = new Int32Array([0, 100, 320, 330, 500, 900, 10000]);

const MAX_PLY = 128;
const MOVES_PER_PLY = 256;

class Position {
  constructor() {
    this.board = new Uint8Array(128);
    // daftar bidak: pieceList[p*16 + i] = kotak. Jauh lebih cepat daripada
    // nyapu 128 kotak tiap kali evaluasi/generate langkah.
    this.pieceList = new Int32Array(16 * 16);
    this.pieceCount = new Int32Array(16);
    this.pieceIdx = new Int32Array(128);
    this.kingSq = new Int32Array(2);
    this.side = WHITE;
    this.castling = 0;
    this.epSq = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.keyA = 0; this.keyB = 0;
    this.ply = 0;          // kedalaman dari akar pencarian
    this.histCount = 0;    // jumlah posisi di riwayat (buat deteksi ulangan)
    this.histA = new Int32Array(1024);
    this.histB = new Int32Array(1024);
    this.histReset = new Int32Array(1024); // batas "tidak bisa diulang lagi" (pion maju / makan)
    // stack undo
    this.sMove = new Int32Array(MAX_PLY + 8);
    this.sCastling = new Int32Array(MAX_PLY + 8);
    this.sEp = new Int32Array(MAX_PLY + 8);
    this.sHalfmove = new Int32Array(MAX_PLY + 8);
    this.sKeyA = new Int32Array(MAX_PLY + 8);
    this.sKeyB = new Int32Array(MAX_PLY + 8);
    this.sDepth = 0;
    // buffer langkah per ply (dialokasikan sekali, dipakai ulang terus)
    this.moveBuf = new Int32Array((MAX_PLY + 8) * MOVES_PER_PLY);
    this.scoreBuf = new Int32Array((MAX_PLY + 8) * MOVES_PER_PLY);
  }

  // ---------------- manipulasi bidak (sekaligus update Zobrist) ----------------
  addPiece(sq, p) {
    this.board[sq] = p;
    const n = this.pieceCount[p];
    this.pieceList[p * 16 + n] = sq;
    this.pieceIdx[sq] = n;
    this.pieceCount[p] = n + 1;
    this.keyA ^= ZOB_PIECE_A[p * 128 + sq]; this.keyB ^= ZOB_PIECE_B[p * 128 + sq];
    if ((p & 7) === KING) this.kingSq[colorOf(p)] = sq;
  }
  removePiece(sq) {
    const p = this.board[sq];
    const i = this.pieceIdx[sq];
    const n = this.pieceCount[p] - 1;
    const last = this.pieceList[p * 16 + n];
    this.pieceList[p * 16 + i] = last;
    this.pieceIdx[last] = i;
    this.pieceCount[p] = n;
    this.board[sq] = EMPTY;
    this.keyA ^= ZOB_PIECE_A[p * 128 + sq]; this.keyB ^= ZOB_PIECE_B[p * 128 + sq];
  }
  movePiece(from, to) {
    const p = this.board[from];
    const i = this.pieceIdx[from];
    this.pieceList[p * 16 + i] = to;
    this.pieceIdx[to] = i;
    this.board[to] = p;
    this.board[from] = EMPTY;
    const base = p * 128;
    this.keyA ^= ZOB_PIECE_A[base + from] ^ ZOB_PIECE_A[base + to];
    this.keyB ^= ZOB_PIECE_B[base + from] ^ ZOB_PIECE_B[base + to];
    if ((p & 7) === KING) this.kingSq[colorOf(p)] = to;
  }

  clear() {
    this.board.fill(EMPTY);
    this.pieceCount.fill(0);
    this.side = WHITE; this.castling = 0; this.epSq = -1;
    this.halfmove = 0; this.fullmove = 1;
    this.keyA = 0; this.keyB = 0;
    this.ply = 0; this.sDepth = 0; this.histCount = 0;
  }

  // ---------------- FEN ----------------
  setFen(fen) {
    this.clear();
    const parts = String(fen).trim().split(/\s+/);
    const rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('FEN tidak valid: ' + fen);
    for (let r = 0; r < 8; r++) {
      const rank = 7 - r;
      let file = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') { file += ch.charCodeAt(0) - 48; continue; }
        const lower = ch.toLowerCase();
        const t = CHAR_PIECE[lower];
        if (!t) throw new Error('FEN tidak valid: ' + fen);
        this.addPiece(rank * 16 + file, mkPiece(t, ch === lower ? BLACK : WHITE));
        file++;
      }
    }
    this.side = (parts[1] === 'b') ? BLACK : WHITE;
    const c = parts[2] || '-';
    if (c.indexOf('K') !== -1) this.castling |= CASTLE_WK;
    if (c.indexOf('Q') !== -1) this.castling |= CASTLE_WQ;
    if (c.indexOf('k') !== -1) this.castling |= CASTLE_BK;
    if (c.indexOf('q') !== -1) this.castling |= CASTLE_BQ;
    this.epSq = (parts[3] && parts[3] !== '-') ? fromAlgebraic(parts[3]) : -1;
    this.halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
    this.fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;
    if (this.side === BLACK) { this.keyA ^= ZOB_SIDE_A; this.keyB ^= ZOB_SIDE_B; }
    this.keyA ^= ZOB_CASTLE_A[this.castling]; this.keyB ^= ZOB_CASTLE_B[this.castling];
    if (this.epSq >= 0) { this.keyA ^= ZOB_EP_A[fileOf(this.epSq)]; this.keyB ^= ZOB_EP_B[fileOf(this.epSq)]; }
    this.histCount = 0;
    this.pushHistory(true);
    return this;
  }

  fen() {
    let out = '';
    for (let rank = 7; rank >= 0; rank--) {
      let run = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.board[rank * 16 + file];
        if (!p) { run++; continue; }
        if (run) { out += run; run = 0; }
        const ch = PIECE_CHAR[p & 7];
        out += colorOf(p) === WHITE ? ch.toUpperCase() : ch;
      }
      if (run) out += run;
      if (rank > 0) out += '/';
    }
    let c = '';
    if (this.castling & CASTLE_WK) c += 'K';
    if (this.castling & CASTLE_WQ) c += 'Q';
    if (this.castling & CASTLE_BK) c += 'k';
    if (this.castling & CASTLE_BQ) c += 'q';
    return out + ' ' + (this.side === WHITE ? 'w' : 'b') + ' ' + (c || '-') + ' ' +
      (this.epSq >= 0 ? algebraic(this.epSq) : '-') + ' ' + this.halfmove + ' ' + this.fullmove;
  }

  // ---------------- riwayat posisi (deteksi ulangan) ----------------
  pushHistory(isReset) {
    const i = this.histCount;
    if (i >= this.histA.length) return;
    this.histA[i] = this.keyA; this.histB[i] = this.keyB;
    this.histReset[i] = isReset ? 1 : 0;
    this.histCount = i + 1;
  }

  // Tanam riwayat posisi dari partai yang sudah berjalan, supaya engine bisa
  // sadar kalau sebuah langkah bakal mengulang posisi (menghindari seri waktu
  // posisinya menang, atau justru mengejar seri waktu kalah).
  // entries: array [keyA, keyB, irreversible] untuk posisi-posisi SEBELUM posisi
  // sekarang, urut dari yang paling awal.
  seedHistory(entries) {
    const curA = this.keyA, curB = this.keyB, curReset = this.histReset[this.histCount - 1] || 0;
    let n = entries.length;
    if (n > this.histA.length - 2) { entries = entries.slice(n - (this.histA.length - 2)); n = entries.length; }
    for (let i = 0; i < n; i++) {
      this.histA[i] = entries[i][0];
      this.histB[i] = entries[i][1];
      this.histReset[i] = entries[i][2] ? 1 : 0;
    }
    this.histA[n] = curA; this.histB[n] = curB; this.histReset[n] = curReset;
    this.histCount = n + 1;
    return this;
  }

  // Ulangan: cukup satu kali ketemu posisi sama di dalam pencarian = anggap seri.
  // Standar engine catur: lebih aman (dan lebih kuat) daripada nunggu 3x.
  isRepetition() {
    const n = this.histCount;
    let i = n - 2;
    const stop = Math.max(0, n - 1 - this.halfmove);
    for (; i >= stop; i -= 2) {
      if (this.histA[i] === this.keyA && this.histB[i] === this.keyB) return true;
      if (this.histReset[i]) break;
    }
    return false;
  }

  // Materi tidak cukup buat skakmat (K vs K, K+B vs K, K+N vs K)
  isInsufficientMaterial() {
    if (this.pieceCount[mkPiece(PAWN, WHITE)] || this.pieceCount[mkPiece(PAWN, BLACK)]) return false;
    if (this.pieceCount[mkPiece(ROOK, WHITE)] || this.pieceCount[mkPiece(ROOK, BLACK)]) return false;
    if (this.pieceCount[mkPiece(QUEEN, WHITE)] || this.pieceCount[mkPiece(QUEEN, BLACK)]) return false;
    const minors = this.pieceCount[mkPiece(KNIGHT, WHITE)] + this.pieceCount[mkPiece(BISHOP, WHITE)] +
      this.pieceCount[mkPiece(KNIGHT, BLACK)] + this.pieceCount[mkPiece(BISHOP, BLACK)];
    return minors <= 1;
  }

  // ---------------- deteksi serangan ----------------
  // Apakah `sq` diserang oleh warna `by`? Dipakai buat legalitas langkah,
  // deteksi skak, castling, dan king safety.
  isAttacked(sq, by) {
    const board = this.board;
    // pion
    if (by === WHITE) {
      let s = sq - 17; if (onBoard(s) && board[s] === (PAWN | 0)) return true;
      s = sq - 15; if (onBoard(s) && board[s] === (PAWN | 0)) return true;
    } else {
      let s = sq + 17; if (onBoard(s) && board[s] === (PAWN | 8)) return true;
      s = sq + 15; if (onBoard(s) && board[s] === (PAWN | 8)) return true;
    }
    // kuda
    const nCode = mkPiece(KNIGHT, by);
    for (let i = 0; i < 8; i++) {
      const s = sq + KNIGHT_OFF[i];
      if (onBoard(s) && board[s] === nCode) return true;
    }
    // raja
    const kCode = mkPiece(KING, by);
    for (let i = 0; i < 8; i++) {
      const s = sq + KING_OFF[i];
      if (onBoard(s) && board[s] === kCode) return true;
    }
    // gajah / menteri (diagonal)
    const bCode = mkPiece(BISHOP, by), qCode = mkPiece(QUEEN, by), rCode = mkPiece(ROOK, by);
    for (let i = 0; i < 4; i++) {
      const off = BISHOP_OFF[i];
      let s = sq + off;
      while (onBoard(s)) {
        const p = board[s];
        if (p) { if (p === bCode || p === qCode) return true; break; }
        s += off;
      }
    }
    // benteng / menteri (lurus)
    for (let i = 0; i < 4; i++) {
      const off = ROOK_OFF[i];
      let s = sq + off;
      while (onBoard(s)) {
        const p = board[s];
        if (p) { if (p === rCode || p === qCode) return true; break; }
        s += off;
      }
    }
    return false;
  }

  inCheck() { return this.isAttacked(this.kingSq[this.side], this.side ^ 1); }
  inCheckFor(color) { return this.isAttacked(this.kingSq[color], color ^ 1); }

  // ---------------- generator langkah ----------------
  // Menulis langkah pseudo-legal ke moveBuf[ply*256 ...], balikin jumlahnya.
  // Legalitas final dicek di makeMove() (lebih murah daripada cek pin manual).
  generate(ply, capturesOnly) {
    const board = this.board;
    const us = this.side, them = us ^ 1;
    const base = ply * MOVES_PER_PLY;
    const buf = this.moveBuf;
    let n = 0;

    // --- pion ---
    const pawnCode = mkPiece(PAWN, us);
    const pc = this.pieceCount[pawnCode];
    const fwd = us === WHITE ? 16 : -16;
    const startRank = us === WHITE ? 1 : 6;
    const promoRank = us === WHITE ? 6 : 1;
    for (let i = 0; i < pc; i++) {
      const from = this.pieceList[pawnCode * 16 + i];
      const onPromoRank = rankOf(from) === promoRank;
      // makan diagonal
      for (let d = -1; d <= 1; d += 2) {
        const to = from + fwd + d;
        if (!onBoard(to)) continue;
        const t = board[to];
        if (t && colorOf(t) === them) {
          if (onPromoRank) {
            buf[base + n++] = encodeMove(from, to, t, QUEEN, 0);
            if (!capturesOnly) {
              buf[base + n++] = encodeMove(from, to, t, ROOK, 0);
              buf[base + n++] = encodeMove(from, to, t, BISHOP, 0);
              buf[base + n++] = encodeMove(from, to, t, KNIGHT, 0);
            }
          } else {
            buf[base + n++] = encodeMove(from, to, t, 0, 0);
          }
        } else if (!t && to === this.epSq) {
          buf[base + n++] = encodeMove(from, to, 0, 0, F_EP);
        }
      }
      // maju
      const one = from + fwd;
      if (onBoard(one) && !board[one]) {
        if (onPromoRank) {
          buf[base + n++] = encodeMove(from, one, 0, QUEEN, 0);
          if (!capturesOnly) {
            buf[base + n++] = encodeMove(from, one, 0, ROOK, 0);
            buf[base + n++] = encodeMove(from, one, 0, BISHOP, 0);
            buf[base + n++] = encodeMove(from, one, 0, KNIGHT, 0);
          }
        } else if (!capturesOnly) {
          buf[base + n++] = encodeMove(from, one, 0, 0, 0);
          if (rankOf(from) === startRank) {
            const two = one + fwd;
            if (!board[two]) buf[base + n++] = encodeMove(from, two, 0, 0, F_DOUBLE);
          }
        }
      }
    }

    // --- kuda ---
    n = this.genStep(buf, base, n, mkPiece(KNIGHT, us), KNIGHT_OFF, 8, them, capturesOnly);
    // --- gajah / benteng / menteri (slider) ---
    n = this.genSlide(buf, base, n, mkPiece(BISHOP, us), BISHOP_OFF, 4, them, capturesOnly);
    n = this.genSlide(buf, base, n, mkPiece(ROOK, us), ROOK_OFF, 4, them, capturesOnly);
    n = this.genSlide(buf, base, n, mkPiece(QUEEN, us), KING_OFF, 8, them, capturesOnly);
    // --- raja ---
    n = this.genStep(buf, base, n, mkPiece(KING, us), KING_OFF, 8, them, capturesOnly);

    // --- castling ---
    if (!capturesOnly) {
      if (us === WHITE) {
        if ((this.castling & CASTLE_WK) && !board[0x05] && !board[0x06] && board[0x07] === mkPiece(ROOK, WHITE) &&
          !this.isAttacked(0x04, BLACK) && !this.isAttacked(0x05, BLACK))
          buf[base + n++] = encodeMove(0x04, 0x06, 0, 0, F_CASTLE);
        if ((this.castling & CASTLE_WQ) && !board[0x03] && !board[0x02] && !board[0x01] && board[0x00] === mkPiece(ROOK, WHITE) &&
          !this.isAttacked(0x04, BLACK) && !this.isAttacked(0x03, BLACK))
          buf[base + n++] = encodeMove(0x04, 0x02, 0, 0, F_CASTLE);
      } else {
        if ((this.castling & CASTLE_BK) && !board[0x75] && !board[0x76] && board[0x77] === mkPiece(ROOK, BLACK) &&
          !this.isAttacked(0x74, WHITE) && !this.isAttacked(0x75, WHITE))
          buf[base + n++] = encodeMove(0x74, 0x76, 0, 0, F_CASTLE);
        if ((this.castling & CASTLE_BQ) && !board[0x73] && !board[0x72] && !board[0x71] && board[0x70] === mkPiece(ROOK, BLACK) &&
          !this.isAttacked(0x74, WHITE) && !this.isAttacked(0x73, WHITE))
          buf[base + n++] = encodeMove(0x74, 0x72, 0, 0, F_CASTLE);
      }
    }
    return n;
  }

  genStep(buf, base, n, code, offs, nOff, them, capturesOnly) {
    const board = this.board;
    const cnt = this.pieceCount[code];
    for (let i = 0; i < cnt; i++) {
      const from = this.pieceList[code * 16 + i];
      for (let k = 0; k < nOff; k++) {
        const to = from + offs[k];
        if (!onBoard(to)) continue;
        const t = board[to];
        if (!t) { if (!capturesOnly) buf[base + n++] = encodeMove(from, to, 0, 0, 0); }
        else if (colorOf(t) === them) buf[base + n++] = encodeMove(from, to, t, 0, 0);
      }
    }
    return n;
  }

  genSlide(buf, base, n, code, offs, nOff, them, capturesOnly) {
    const board = this.board;
    const cnt = this.pieceCount[code];
    for (let i = 0; i < cnt; i++) {
      const from = this.pieceList[code * 16 + i];
      for (let k = 0; k < nOff; k++) {
        const off = offs[k];
        let to = from + off;
        while (onBoard(to)) {
          const t = board[to];
          if (!t) { if (!capturesOnly) buf[base + n++] = encodeMove(from, to, 0, 0, 0); }
          else {
            if (colorOf(t) === them) buf[base + n++] = encodeMove(from, to, t, 0, 0);
            break;
          }
          to += off;
        }
      }
    }
    return n;
  }

  // ---------------- make / unmake ----------------
  // Balikin false (dan otomatis undo) kalau langkahnya bikin raja sendiri kena skak.
  makeMove(m) {
    const from = MFROM(m), to = MTO(m);
    const us = this.side, them = us ^ 1;
    const d = this.sDepth;
    this.sMove[d] = m;
    this.sCastling[d] = this.castling;
    this.sEp[d] = this.epSq;
    this.sHalfmove[d] = this.halfmove;
    this.sKeyA[d] = this.keyA;
    this.sKeyB[d] = this.keyB;
    this.sDepth = d + 1;

    const piece = this.board[from];
    const pType = piece & 7;
    const cap = MCAP(m);
    const promo = MPROMO(m);

    // buang kunci ep & castling lama (dipasang ulang di bawah)
    if (this.epSq >= 0) { this.keyA ^= ZOB_EP_A[fileOf(this.epSq)]; this.keyB ^= ZOB_EP_B[fileOf(this.epSq)]; }
    this.keyA ^= ZOB_CASTLE_A[this.castling]; this.keyB ^= ZOB_CASTLE_B[this.castling];

    if (m & F_EP) {
      this.removePiece(to - (us === WHITE ? 16 : -16));
    } else if (cap) {
      this.removePiece(to);
    }
    this.movePiece(from, to);
    if (promo) {
      this.removePiece(to);
      this.addPiece(to, mkPiece(promo, us));
    }
    if (m & F_CASTLE) {
      if (to === 0x06) this.movePiece(0x07, 0x05);
      else if (to === 0x02) this.movePiece(0x00, 0x03);
      else if (to === 0x76) this.movePiece(0x77, 0x75);
      else if (to === 0x72) this.movePiece(0x70, 0x73);
    }

    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    this.epSq = (m & F_DOUBLE) ? (from + (us === WHITE ? 16 : -16)) : -1;
    const isReset = (pType === PAWN) || cap !== 0 || (m & F_EP) !== 0;
    this.halfmove = isReset ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.side = them;

    this.keyA ^= ZOB_SIDE_A; this.keyB ^= ZOB_SIDE_B;
    this.keyA ^= ZOB_CASTLE_A[this.castling]; this.keyB ^= ZOB_CASTLE_B[this.castling];
    if (this.epSq >= 0) { this.keyA ^= ZOB_EP_A[fileOf(this.epSq)]; this.keyB ^= ZOB_EP_B[fileOf(this.epSq)]; }

    // legalitas: raja yang baru jalan nggak boleh ketinggalan dalam keadaan skak
    if (this.isAttacked(this.kingSq[us], them)) { this.undoCore(); return false; }

    this.ply++;
    this.pushHistory(isReset);
    return true;
  }

  // Batalkan langkah yang sudah legal (kebalikan makeMove yang sukses).
  unmakeMove() {
    this.histCount--;
    this.ply--;
    this.undoCore();
  }

  // Pembatalan "mentah": mengembalikan papan, kunci, dan hak-hak posisi dari
  // stack undo — tanpa menyentuh riwayat/ply. Dipakai dua jalur: langkah ilegal
  // (riwayat belum dicatat) dan unmakeMove() biasa.
  undoCore() {
    const d = this.sDepth - 1;
    this.sDepth = d;
    const m = this.sMove[d];
    const from = MFROM(m), to = MTO(m);
    const them = this.side, us = them ^ 1;

    this.side = us;
    if (us === BLACK) this.fullmove--;
    this.castling = this.sCastling[d];
    this.epSq = this.sEp[d];
    this.halfmove = this.sHalfmove[d];

    if (m & F_CASTLE) {
      if (to === 0x06) this.movePiece(0x05, 0x07);
      else if (to === 0x02) this.movePiece(0x03, 0x00);
      else if (to === 0x76) this.movePiece(0x75, 0x77);
      else if (to === 0x72) this.movePiece(0x73, 0x70);
    }
    const promo = MPROMO(m);
    if (promo) {
      this.removePiece(to);
      this.addPiece(to, mkPiece(PAWN, us));
    }
    this.movePiece(to, from);
    const cap = MCAP(m);
    if (m & F_EP) {
      this.addPiece(to - (us === WHITE ? 16 : -16), mkPiece(PAWN, them));
    } else if (cap) {
      this.addPiece(to, cap);
    }

    this.keyA = this.sKeyA[d]; this.keyB = this.sKeyB[d];
  }

  // Null move: lewatin giliran (buat null-move pruning). Tidak boleh dipakai saat skak.
  makeNull() {
    const d = this.sDepth;
    this.sMove[d] = 0;
    this.sCastling[d] = this.castling;
    this.sEp[d] = this.epSq;
    this.sHalfmove[d] = this.halfmove;
    this.sKeyA[d] = this.keyA;
    this.sKeyB[d] = this.keyB;
    this.sDepth = d + 1;
    if (this.epSq >= 0) { this.keyA ^= ZOB_EP_A[fileOf(this.epSq)]; this.keyB ^= ZOB_EP_B[fileOf(this.epSq)]; }
    this.epSq = -1;
    this.side ^= 1;
    this.halfmove++;
    this.keyA ^= ZOB_SIDE_A; this.keyB ^= ZOB_SIDE_B;
    this.ply++;
    this.pushHistory(true); // null move memutus rantai ulangan
  }
  unmakeNull() {
    const d = this.sDepth - 1;
    this.sDepth = d;
    this.histCount--;
    this.ply--;
    this.side ^= 1;
    this.castling = this.sCastling[d];
    this.epSq = this.sEp[d];
    this.halfmove = this.sHalfmove[d];
    this.keyA = this.sKeyA[d]; this.keyB = this.sKeyB[d];
  }

  hasNonPawnMaterial(color) {
    return this.pieceCount[mkPiece(KNIGHT, color)] + this.pieceCount[mkPiece(BISHOP, color)] +
      this.pieceCount[mkPiece(ROOK, color)] + this.pieceCount[mkPiece(QUEEN, color)] > 0;
  }

  // ---------------- SEE: static exchange evaluation ----------------
  // "Kalau aku makan di kotak ini, setelah semua tukar-tukaran selesai, aku
  // untung atau rugi?" Dipakai buat urutan langkah & pangkas makan yang jelek.
  // Trik: papan dimodifikasi sementara (bidak diangkat) supaya serangan
  // tembus/x-ray otomatis kebaca, lalu dipulihkan persis seperti semula.
  see(m) {
    const board = this.board;
    const from = MFROM(m), to = MTO(m);
    const us = this.side;
    const attacker = board[from];
    let capturedType;
    let epPawnSq = -1;
    if (m & F_EP) {
      capturedType = PAWN;
      epPawnSq = to - (us === WHITE ? 16 : -16);
    } else {
      capturedType = MCAP(m) & 7;
    }

    const gain = SEE_GAIN;
    let d = 0;
    gain[0] = SEE_VAL[capturedType];
    const promo = MPROMO(m);
    if (promo) gain[0] += SEE_VAL[promo] - SEE_VAL[PAWN];

    // --- ubah papan sementara ---
    const savedSquares = SEE_SQ, savedPieces = SEE_PC;
    let nSaved = 0;
    savedSquares[nSaved] = from; savedPieces[nSaved++] = board[from];
    savedSquares[nSaved] = to; savedPieces[nSaved++] = board[to];
    if (epPawnSq >= 0) { savedSquares[nSaved] = epPawnSq; savedPieces[nSaved++] = board[epPawnSq]; board[epPawnSq] = EMPTY; }
    board[from] = EMPTY;
    board[to] = promo ? mkPiece(promo, us) : attacker;

    let onSquare = promo ? promo : (attacker & 7);
    let side = us ^ 1;
    for (;;) {
      const sq = this.leastValuableAttacker(to, side, board);
      if (sq < 0) break;
      d++;
      gain[d] = SEE_VAL[onSquare] - gain[d - 1];
      if (Math.max(-gain[d - 1], gain[d]) < 0) break; // sudah pasti rugi buat yang jalan
      onSquare = board[sq] & 7;
      savedSquares[nSaved] = sq; savedPieces[nSaved++] = board[sq];
      board[to] = board[sq];
      board[sq] = EMPTY;
      side ^= 1;
      if (d >= 30) break;
    }

    // --- pulihkan papan ---
    for (let i = nSaved - 1; i >= 0; i--) board[savedSquares[i]] = savedPieces[i];

    while (d > 0) { gain[d - 1] = -Math.max(-gain[d - 1], gain[d]); d--; }
    return gain[0];
  }

  // Penyerang termurah ke `sq` dari warna `by`, melihat papan apa adanya.
  leastValuableAttacker(sq, by, board) {
    // pion
    if (by === WHITE) {
      let s = sq - 17; if (onBoard(s) && board[s] === PAWN) return s;
      s = sq - 15; if (onBoard(s) && board[s] === PAWN) return s;
    } else {
      let s = sq + 17; if (onBoard(s) && board[s] === (PAWN | 8)) return s;
      s = sq + 15; if (onBoard(s) && board[s] === (PAWN | 8)) return s;
    }
    // kuda
    const nCode = mkPiece(KNIGHT, by);
    for (let i = 0; i < 8; i++) {
      const s = sq + KNIGHT_OFF[i];
      if (onBoard(s) && board[s] === nCode) return s;
    }
    // slider: satu kali jalan 8 arah, ambil yang paling murah
    const bCode = mkPiece(BISHOP, by), rCode = mkPiece(ROOK, by), qCode = mkPiece(QUEEN, by), kCode = mkPiece(KING, by);
    let bestSq = -1, bestVal = 1 << 30;
    for (let i = 0; i < 4; i++) {
      const off = BISHOP_OFF[i];
      let s = sq + off;
      while (onBoard(s)) {
        const p = board[s];
        if (p) {
          if (p === bCode && SEE_VAL[BISHOP] < bestVal) { bestVal = SEE_VAL[BISHOP]; bestSq = s; }
          else if (p === qCode && SEE_VAL[QUEEN] < bestVal) { bestVal = SEE_VAL[QUEEN]; bestSq = s; }
          break;
        }
        s += off;
      }
    }
    for (let i = 0; i < 4; i++) {
      const off = ROOK_OFF[i];
      let s = sq + off;
      while (onBoard(s)) {
        const p = board[s];
        if (p) {
          if (p === rCode && SEE_VAL[ROOK] < bestVal) { bestVal = SEE_VAL[ROOK]; bestSq = s; }
          else if (p === qCode && SEE_VAL[QUEEN] < bestVal) { bestVal = SEE_VAL[QUEEN]; bestSq = s; }
          break;
        }
        s += off;
      }
    }
    if (bestSq >= 0) return bestSq;
    // raja paling akhir (paling "mahal" resikonya)
    for (let i = 0; i < 8; i++) {
      const s = sq + KING_OFF[i];
      if (onBoard(s) && board[s] === kCode) return s;
    }
    return -1;
  }
}

// buffer SEE dipakai bareng (search single-thread, jadi aman & bebas alokasi)
const SEE_GAIN = new Int32Array(34);
const SEE_SQ = new Int32Array(40);
const SEE_PC = new Int32Array(40);

module.exports = {
  Position,
  EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
  mkPiece, typeOf, colorOf, PIECE_CHAR, CHAR_PIECE,
  KNIGHT_OFF, BISHOP_OFF, ROOK_OFF, KING_OFF,
  onBoard, fileOf, rankOf, sq64, algebraic, fromAlgebraic,
  encodeMove, MFROM, MTO, MCAP, MPROMO, isEP, isCastle, isDouble, isCapture, isQuiet, moveToUci,
  SEE_VAL, MAX_PLY, MOVES_PER_PLY,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ,
};
