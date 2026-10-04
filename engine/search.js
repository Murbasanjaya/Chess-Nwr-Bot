'use strict';
// ============================================================================
// search.js — otak pencarian langkah.
//
// Negamax fail-soft + alpha-beta, dibungkus iterative deepening dengan batas
// waktu. Teknik yang dipakai (semuanya teknik yang dipakai engine catur serius):
//
//   ORDERING    : TT move > promosi > makan bagus (SEE>=0, MVV-LVA) > killer >
//                 counter-move > history heuristic > makan rugi
//   TABEL       : transposition table (dua kunci 32-bit, typed array, persisten
//                 antar langkah + penuaan generasi)
//   PEMANGKASAN : null-move pruning, reverse futility, razoring, futility,
//                 late move pruning, SEE pruning, mate-distance pruning
//   REDUKSI     : Late Move Reductions (tabel log), internal iterative reduction
//   PERLUASAN   : check extension (dibatasi), recapture/promosi
//   DAUN        : quiescence search dengan SEE + delta pruning
//   AKAR        : aspiration window, PVS, plus penilaian SEMUA langkah akar
//                 (dipakai buat badge kualitas langkah & level Elo rendah)
//
// Pencarian berhenti pakai flag `stopped` (bukan exception) biar loop panasnya
// bebas try/catch — lumayan ngaruh ke kecepatan di V8.
// ============================================================================

const P = require('./position.js');
const { evaluate } = require('./evaluate.js');
const {
  Position, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
  mkPiece, MOVES_PER_PLY, MAX_PLY,
  MFROM, MTO, MCAP, MPROMO, isEP, isCastle, SEE_VAL, moveToUci,
} = P;

const INF = 32000;
const MATE = 31000;
const MATE_IN_MAX = MATE - MAX_PLY;   // di atas ini = skor skakmat
const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;

// skor move ordering
const S_TT = 1 << 24;
const S_PROMO = 1 << 23;
const S_GOOD_CAP = 1 << 22;
const S_KILLER1 = 1 << 21;
const S_KILLER2 = (1 << 21) - 100;
const S_COUNTER = (1 << 21) - 200;
const S_BAD_CAP = -(1 << 22);
const HISTORY_MAX = (1 << 20) - 1;

// tabel reduksi LMR: makin dalam & makin belakang urutannya, makin dipangkas
const LMR = [];
for (let d = 0; d < 64; d++) {
  LMR[d] = new Int32Array(64);
  for (let m = 0; m < 64; m++) {
    LMR[d][m] = (d < 3 || m < 2) ? 0 : Math.floor(0.80 + Math.log(d) * Math.log(m) / 2.1);
  }
}
// batas jumlah langkah diam yang dilihat di kedalaman kecil (late move pruning)
const LMP = new Int32Array([0, 5, 8, 13, 20, 29, 40, 53, 68]);

function defaultTtEntries() {
  const mb = parseInt(process.env.CATUR_TT_MB || '', 10);
  if (mb && mb > 0) {
    // ~19 byte per entry (6 typed array). Ambil pangkat dua terbesar yang masih
    // masuk jatah: ukuran tabel harus pangkat dua karena indeksnya pakai mask.
    const bytes = mb * 1024 * 1024;
    let n = 1024;
    while (n * 2 * 19 <= bytes && n < (1 << 24)) n <<= 1;
    return n;
  }
  return 1 << 20; // ~1 juta entry, sekitar 19MB — aman buat HP/Termux juga
}

class Searcher {
  constructor(ttEntries) {
    this.ttSize = ttEntries || defaultTtEntries();
    this.ttMask = this.ttSize - 1;
    this.ttKeyA = new Int32Array(this.ttSize);
    this.ttKeyB = new Int32Array(this.ttSize);
    this.ttMove = new Int32Array(this.ttSize);
    this.ttScore = new Int32Array(this.ttSize);
    this.ttDepth = new Int8Array(this.ttSize);
    this.ttFlag = new Uint8Array(this.ttSize);
    this.ttAge = new Uint8Array(this.ttSize);
    this.generation = 0;

    this.killers = new Int32Array((MAX_PLY + 8) * 2);
    this.history = new Int32Array(16 * 128);
    this.counter = new Int32Array(16 * 128);
    this.evalStack = new Int32Array(MAX_PLY + 8);
    this.pvLine = [];

    this.nodes = 0;
    this.qnodes = 0;
    this.stopped = false;
    this.deadline = 0;
    this.nodeLimit = Infinity;
    this.checkCounter = 0;
    this.rootSide = WHITE;
    this.contempt = 8;   // sedikit menghindari seri — lebih suka terus main
    this.seldepth = 0;
  }

  // ---------------- transposition table ----------------
  ttProbe(keyA, keyB) {
    const i = (keyA & this.ttMask) >>> 0;
    if (this.ttKeyA[i] === keyA && this.ttKeyB[i] === keyB) return i;
    return -1;
  }
  ttStore(keyA, keyB, depth, score, flag, move, ply) {
    const i = (keyA & this.ttMask) >>> 0;
    const sameSlot = this.ttKeyA[i] === keyA && this.ttKeyB[i] === keyB;
    // ganti kalau: slot kosong/beda posisi, generasi lama, lebih dalam, atau exact
    if (!sameSlot || this.ttAge[i] !== this.generation || depth >= this.ttDepth[i] - 2 || flag === TT_EXACT) {
      let s = score;
      if (s >= MATE_IN_MAX) s += ply; else if (s <= -MATE_IN_MAX) s -= ply;
      this.ttKeyA[i] = keyA; this.ttKeyB[i] = keyB;
      this.ttDepth[i] = depth; this.ttScore[i] = s; this.ttFlag[i] = flag;
      this.ttAge[i] = this.generation;
      if (move || !sameSlot) this.ttMove[i] = move;
    }
  }
  ttScoreFor(i, ply) {
    let s = this.ttScore[i];
    if (s >= MATE_IN_MAX) s -= ply; else if (s <= -MATE_IN_MAX) s += ply;
    return s;
  }
  clearTables() {
    this.ttKeyA.fill(0); this.ttKeyB.fill(0); this.ttMove.fill(0);
    this.ttScore.fill(0); this.ttDepth.fill(0); this.ttFlag.fill(0); this.ttAge.fill(0);
    this.history.fill(0); this.counter.fill(0); this.killers.fill(0);
    this.generation = 0;
  }

  // ---------------- manajemen waktu ----------------
  checkTime() {
    if ((this.checkCounter = (this.checkCounter + 1) & 1023) === 0) {
      if (Date.now() >= this.deadline || this.nodes >= this.nodeLimit) this.stopped = true;
    }
  }

  drawScore(pos) {
    // sedikit "contempt": seri dinilai agak jelek buat pihak yang kita bantu,
    // jadi engine nggak gampang nawarin/nerima ulangan kalau posisinya masih bisa dimainkan
    return pos.side === this.rootSide ? -this.contempt : this.contempt;
  }

  // ---------------- skoring & pemilihan langkah ----------------
  scoreMoves(pos, ply, n, ttMove, prevMove) {
    const base = ply * MOVES_PER_PLY;
    const buf = pos.moveBuf, sc = pos.scoreBuf;
    const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
    const counterIdx = prevMove ? (pos.board[MTO(prevMove)] * 128 + MTO(prevMove)) : -1;
    const counterMove = counterIdx >= 0 ? this.counter[counterIdx] : 0;
    for (let i = 0; i < n; i++) {
      const m = buf[base + i];
      let s;
      if (m === ttMove) {
        s = S_TT;
      } else {
        const promo = MPROMO(m);
        const cap = MCAP(m);
        if (promo === QUEEN) {
          s = S_PROMO + (cap ? SEE_VAL[cap & 7] : 0);
        } else if (cap || isEP(m)) {
          const victim = isEP(m) ? PAWN : (cap & 7);
          const attacker = pos.board[MFROM(m)] & 7;
          const mvvlva = SEE_VAL[victim] * 16 - SEE_VAL[attacker];
          // makan yang jelas rugi ditaruh paling belakang
          s = (SEE_VAL[victim] >= SEE_VAL[attacker] || pos.see(m) >= 0)
            ? S_GOOD_CAP + mvvlva : S_BAD_CAP + mvvlva;
        } else if (promo) {
          s = S_PROMO - 1000 + SEE_VAL[promo];
        } else if (m === k1) {
          s = S_KILLER1;
        } else if (m === k2) {
          s = S_KILLER2;
        } else if (m === counterMove) {
          s = S_COUNTER;
        } else {
          s = this.history[pos.board[MFROM(m)] * 128 + MTO(m)];
        }
      }
      sc[base + i] = s;
    }
  }

  // selection sort satu langkah: ambil langkah terbaik yang belum dicoba.
  // Lebih cepat daripada sort penuh, karena node biasanya cutoff di langkah awal.
  pickMove(pos, base, i, n) {
    const buf = pos.moveBuf, sc = pos.scoreBuf;
    let bi = i, bs = sc[base + i];
    for (let j = i + 1; j < n; j++) {
      if (sc[base + j] > bs) { bs = sc[base + j]; bi = j; }
    }
    if (bi !== i) {
      const tm = buf[base + i]; buf[base + i] = buf[base + bi]; buf[base + bi] = tm;
      const ts = sc[base + i]; sc[base + i] = sc[base + bi]; sc[base + bi] = ts;
    }
    return buf[base + i];
  }

  updateQuietHeuristics(pos, m, ply, depth, prevMove) {
    const pieceIdx = pos.board[MFROM(m)] * 128 + MTO(m);
    const bonus = depth * depth + depth;
    let h = this.history[pieceIdx] + bonus;
    if (h > HISTORY_MAX) {
      // penuaan: semua history dibagi dua biar nggak jenuh di satu langkah
      for (let i = 0; i < this.history.length; i++) this.history[i] >>= 1;
      h = this.history[pieceIdx] + bonus;
    }
    this.history[pieceIdx] = h;
    const kBase = ply * 2;
    if (this.killers[kBase] !== m) {
      this.killers[kBase + 1] = this.killers[kBase];
      this.killers[kBase] = m;
    }
    if (prevMove) this.counter[pos.board[MTO(prevMove)] * 128 + MTO(prevMove)] = m;
  }

  penalizeQuiet(pos, m, depth) {
    const idx = pos.board[MFROM(m)] * 128 + MTO(m);
    const h = this.history[idx] - (depth * depth);
    this.history[idx] = h < -HISTORY_MAX ? -HISTORY_MAX : h;
  }

  // ---------------- quiescence search ----------------
  // Di daun pohon, posisi nggak boleh dinilai pas tengah-tengah tukar bidak.
  // Jadi kita lanjut cuma lihat langkah makan (+ promosi) sampai posisinya "tenang".
  quiescence(pos, alpha, beta, ply) {
    this.nodes++; this.qnodes++;
    this.checkTime();
    if (this.stopped) return 0;
    if (ply > this.seldepth) this.seldepth = ply;
    if (ply >= MAX_PLY - 2) return evaluate(pos) * (pos.side === WHITE ? 1 : -1);
    if (pos.halfmove >= 100 || pos.isInsufficientMaterial() || pos.isRepetition()) return this.drawScore(pos);

    const inCheck = pos.inCheck();
    let standPat = -INF;
    if (!inCheck) {
      standPat = evaluate(pos) * (pos.side === WHITE ? 1 : -1);
      if (standPat >= beta) return standPat;
      if (standPat > alpha) alpha = standPat;
    }

    const keyA = pos.keyA, keyB = pos.keyB;
    const ttIdx = this.ttProbe(keyA, keyB);
    let ttMove = 0;
    if (ttIdx >= 0) {
      ttMove = this.ttMove[ttIdx];
      const s = this.ttScoreFor(ttIdx, ply);
      const f = this.ttFlag[ttIdx];
      if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
    }

    // saat diskak: semua langkah legal wajib dilihat (nggak ada opsi "diam saja")
    const n = pos.generate(ply, !inCheck);
    this.scoreMoves(pos, ply, n, ttMove, 0);
    const base = ply * MOVES_PER_PLY;
    let best = standPat, bestMove = 0, legal = 0;

    for (let i = 0; i < n; i++) {
      const m = this.pickMove(pos, base, i, n);
      if (!inCheck) {
        // delta pruning: makan yang bahkan kalau gratis pun nggak nyampe alpha
        const victim = isEP(m) ? PAWN : (MCAP(m) & 7);
        const promo = MPROMO(m);
        const gainMax = SEE_VAL[victim] + (promo ? SEE_VAL[promo] : 0) + 120;
        if (standPat + gainMax < alpha) continue;
        // SEE pruning: jangan buang waktu di tukaran yang jelas rugi.
        // scoreMoves() sudah menandai makan rugi dengan skor negatif besar,
        // jadi di sini cukup lihat skornya — nggak perlu hitung SEE dua kali.
        if (pos.scoreBuf[base + i] < 0) continue;
      }
      if (!pos.makeMove(m)) continue;
      legal++;
      const score = -this.quiescence(pos, -beta, -alpha, ply + 1);
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (score > best) {
        best = score; bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) break;
        }
      }
    }

    if (inCheck && legal === 0) return -MATE + ply; // skakmat
    if (!this.stopped) {
      const flag = best >= beta ? TT_LOWER : TT_UPPER;
      this.ttStore(keyA, keyB, 0, best, flag, bestMove, ply);
    }
    return best;
  }

  // ---------------- negamax utama ----------------
  negamax(pos, depth, alpha, beta, ply, canNull, prevMove, extLeft) {
    if (depth <= 0) return this.quiescence(pos, alpha, beta, ply);
    this.nodes++;
    this.checkTime();
    if (this.stopped) return 0;
    if (ply > this.seldepth) this.seldepth = ply;

    const isPv = beta - alpha > 1;
    const rootNode = ply === 0;

    if (!rootNode) {
      if (pos.halfmove >= 100 || pos.isInsufficientMaterial() || pos.isRepetition()) return this.drawScore(pos);
      if (ply >= MAX_PLY - 2) return evaluate(pos) * (pos.side === WHITE ? 1 : -1);
      // mate distance pruning: kalau skakmat lebih cepat sudah ketemu, nggak usah cari di sini
      const mateAlpha = alpha > -MATE + ply ? alpha : -MATE + ply;
      const mateBeta = beta < MATE - ply - 1 ? beta : MATE - ply - 1;
      if (mateAlpha >= mateBeta) return mateAlpha;
      alpha = mateAlpha; beta = mateBeta;
    }

    const keyA = pos.keyA, keyB = pos.keyB;
    const ttIdx = this.ttProbe(keyA, keyB);
    let ttMove = 0, ttScore = 0, ttFlag = 0, ttDepth = -1;
    if (ttIdx >= 0) {
      ttMove = this.ttMove[ttIdx];
      ttScore = this.ttScoreFor(ttIdx, ply);
      ttFlag = this.ttFlag[ttIdx];
      ttDepth = this.ttDepth[ttIdx];
      if (!isPv && ttDepth >= depth) {
        if (ttFlag === TT_EXACT) return ttScore;
        if (ttFlag === TT_LOWER && ttScore >= beta) return ttScore;
        if (ttFlag === TT_UPPER && ttScore <= alpha) return ttScore;
      }
    }

    const inCheck = pos.inCheck();
    const staticEval = inCheck ? -INF : evaluate(pos) * (pos.side === WHITE ? 1 : -1);
    this.evalStack[ply] = staticEval;
    // posisi membaik dibanding dua ply lalu? kalau membaik, pangkasnya lebih hati-hati
    const improving = !inCheck && ply >= 2 && this.evalStack[ply - 2] !== -INF && staticEval > this.evalStack[ply - 2];

    if (!isPv && !inCheck && Math.abs(beta) < MATE_IN_MAX) {
      // reverse futility: posisi udah jauh di atas beta, lawan nggak akan ke sini
      if (depth <= 8 && staticEval - (85 - (improving ? 20 : 0)) * depth >= beta) return staticEval;
      // razoring: posisi jauh di bawah alpha di kedalaman kecil — cek cepat pakai
      // quiescence. Dibatasi d<=2 dengan margin sempit; kalau dilebarkan, nilai
      // yang dibalikin mulai sering salah.
      if (depth <= 2 && staticEval + 140 * depth < alpha) {
        const q = this.quiescence(pos, alpha, beta, ply);
        if (q < alpha) return q;
      }
      // null-move pruning: kasih lawan giliran gratis; kalau masih >= beta, cabang ini aman dipangkas
      if (canNull && depth >= 3 && staticEval >= beta && pos.hasNonPawnMaterial(pos.side)) {
        const R = 3 + ((depth / 6) | 0) + (improving ? 1 : 0);
        pos.makeNull();
        const score = -this.negamax(pos, depth - 1 - R, -beta, -beta + 1, ply + 1, false, 0, extLeft);
        pos.unmakeNull();
        if (this.stopped) return 0;
        if (score >= beta) return score >= MATE_IN_MAX ? beta : score;
      }
    }

    // Internal iterative reduction: nggak ada TT move -> kurangi kedalaman
    // sedikit. Lebih baik dapat TT move dulu daripada mencari dalam tanpa
    // urutan langkah yang bagus. Node jalur utama (PV) dikecualikan supaya
    // akurasi garis utamanya nggak ikut berkurang.
    let d = depth;
    if (!ttMove && !isPv && d >= 5 && !inCheck) d--;

    const n = pos.generate(ply, false);
    this.scoreMoves(pos, ply, n, ttMove, prevMove);
    const base = ply * MOVES_PER_PLY;

    let best = -INF, bestMove = 0, legal = 0, quietsTried = 0;
    const origAlpha = alpha;
    const quietList = QUIET_SCRATCH[ply] || (QUIET_SCRATCH[ply] = new Int32Array(64));
    let nQuiet = 0;

    for (let i = 0; i < n; i++) {
      const m = this.pickMove(pos, base, i, n);
      const mScore = pos.scoreBuf[base + i];
      const quiet = MCAP(m) === 0 && !isEP(m) && MPROMO(m) === 0;

      // --- pemangkasan sebelum langkahnya dijalankan ---
      if (!rootNode && !isPv && !inCheck && legal > 0 && best > -MATE_IN_MAX) {
        if (quiet) {
          // late move pruning: di kedalaman kecil, langkah diam urutan belakang dilewat
          if (d <= 8 && quietsTried >= LMP[d] + (improving ? (d * 2) : 0)) continue;
          // Futility pruning. Patokannya kedalaman SETELAH reduksi LMR, bukan
          // kedalaman penuh — kalau pakai kedalaman penuh, marginnya jadi
          // ratusan centipawn di d=5/6 dan seluruh langkah diam ikut dipangkas.
          // Itu bikin skor node-nya jauh terlalu pesimis (pernah kejadian:
          // selisih 440cp dibanding pencarian yang benar).
          const red = d >= 3 ? LMR[d < 63 ? d : 63][legal < 63 ? legal : 63] : 0;
          const lmrDepth = d - 1 - red;
          if (lmrDepth <= 4 && staticEval + 110 + 130 * (lmrDepth > 0 ? lmrDepth : 0) <= alpha) {
            quietsTried++; continue;
          }
        } else if (d <= 5 && mScore < S_GOOD_CAP && pos.see(m) < -90 * d) {
          continue; // makan rugi di kedalaman kecil
        }
      }

      if (!pos.makeMove(m)) continue;
      legal++;
      if (quiet) { quietsTried++; if (nQuiet < 64) quietList[nQuiet++] = m; }

      const givesCheck = pos.inCheck();
      // check extension: rangkaian skak dicari lebih dalam (dibatasi budget ext)
      let ext = 0;
      if (givesCheck && extLeft > 0 && (d >= 2 || isPv)) ext = 1;

      let score;
      if (legal === 1) {
        score = -this.negamax(pos, d - 1 + ext, -beta, -alpha, ply + 1, true, m, extLeft - ext);
      } else {
        // Late Move Reductions
        let r = 0;
        if (d >= 3 && quiet && !givesCheck) {
          const di = d < 63 ? d : 63;
          const mi = legal < 63 ? legal : 63;
          r = LMR[di][mi];
          if (isPv) r--;
          if (improving) r--;
          if (mScore >= S_KILLER2) r--;          // killer / counter-move
          else if (mScore < 0) r++;              // history-nya jelek
          if (r < 0) r = 0;
          if (r > d - 2) r = d - 2;
        }
        score = -this.negamax(pos, d - 1 - r + ext, -alpha - 1, -alpha, ply + 1, true, m, extLeft - ext);
        if (score > alpha && r > 0) {
          score = -this.negamax(pos, d - 1 + ext, -alpha - 1, -alpha, ply + 1, true, m, extLeft - ext);
        }
        if (score > alpha && score < beta) {
          score = -this.negamax(pos, d - 1 + ext, -beta, -alpha, ply + 1, true, m, extLeft - ext);
        }
      }
      pos.unmakeMove();
      if (this.stopped) return 0;

      if (score > best) {
        best = score; bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) {
            if (quiet) {
              this.updateQuietHeuristics(pos, m, ply, d, prevMove);
              // langkah diam lain yang sudah dicoba tapi gagal: history-nya dikurangi
              for (let q = 0; q < nQuiet; q++) {
                if (quietList[q] !== m) this.penalizeQuiet(pos, quietList[q], d);
              }
            }
            break;
          }
        }
      }
    }

    if (legal === 0) return inCheck ? -MATE + ply : this.drawScore(pos);

    if (!this.stopped) {
      const flag = best >= beta ? TT_LOWER : (best > origAlpha ? TT_EXACT : TT_UPPER);
      this.ttStore(keyA, keyB, d, best, flag, bestMove, ply);
    }
    return best;
  }

  // ---------------- pencarian akar ----------------
  /**
   * opts: { maxDepth, budgetMs, nodeLimit, classMargin, gradeAll, onIteration }
   *
   * Dua tahap, sengaja dipisah:
   *
   *  1) PENCARIAN UTAMA — alpha-beta + PVS + aspiration window tanpa kompromi.
   *     Ini yang nentuin kekuatan main; jendela pencariannya sesempit mungkin
   *     biar kedalamannya maksimal.
   *  2) LINTASAN PENILAIAN — sesudahnya, langkah-langkah akar yang lain dinilai
   *     di kedalaman sedikit lebih dangkal (TT-nya sudah panas jadi murah),
   *     cuma buat badge kualitas langkah & level Elo rendah.
   *
   * Dulu dua hal ini digabung jadi satu, dan itu bikin engine kehilangan 2–3
   * ply kedalaman cuma demi angka buat badge.
   *
   * Balikin { best, score, depth, seldepth, nodes, timeMs, pv, rootMoves }.
   */
  searchRoot(pos, opts) {
    const maxDepth = Math.min(opts.maxDepth || 64, MAX_PLY - 4);
    const budgetMs = opts.budgetMs == null ? 2000 : opts.budgetMs;
    const classMargin = opts.classMargin == null ? 300 : opts.classMargin;
    const gradeAll = opts.gradeAll !== false;
    const t0 = Date.now();
    this.deadline = t0 + budgetMs;
    this.nodeLimit = opts.nodeLimit || Infinity;
    this.stopped = false;
    this.nodes = 0; this.qnodes = 0; this.seldepth = 0;
    this.rootSide = pos.side;
    this.generation = (this.generation + 1) & 255;
    this.killers.fill(0);

    // kumpulkan langkah akar yang benar-benar legal
    const n = pos.generate(0, false);
    const cand = [];
    for (let i = 0; i < n; i++) {
      const m = pos.moveBuf[i];
      if (!pos.makeMove(m)) continue;
      pos.unmakeMove();
      cand.push(m);
    }
    if (cand.length === 0) {
      return { best: 0, score: 0, depth: 0, seldepth: 0, nodes: 0, qnodes: 0, timeMs: 0, pv: [], rootMoves: [], mate: null };
    }

    // urutan awal: TT move dulu, lalu MVV-LVA/history
    let order;
    {
      this.scoreMoves(pos, 0, n, this.ttProbeMove(pos), 0);
      const ranked = [];
      for (let i = 0; i < n; i++) ranked.push([pos.moveBuf[i], pos.scoreBuf[i]]);
      ranked.sort((a, b) => b[1] - a[1]);
      const legalSet = new Set(cand);
      order = ranked.map(x => x[0]).filter(m => legalSet.has(m));
      if (order.length !== cand.length) order = cand.slice();
    }

    let scores = new Int32Array(order.length).fill(-INF);
    let bestMove = order[0], bestScore = -INF, completedDepth = 0;

    for (let depth = 1; depth <= maxDepth; depth++) {
      // jangan mulai iterasi baru kalau jatah waktunya hampir pasti nggak cukup
      if (depth > 1 && Date.now() - t0 > budgetMs * 0.47) break;

      let alpha = -INF, beta = INF, delta = 28;
      if (depth >= 5 && Math.abs(bestScore) < MATE_IN_MAX) {
        alpha = bestScore - delta; beta = bestScore + delta;
      }
      let iter = null;
      for (;;) {
        iter = this.rootIteration(pos, order, depth, alpha, beta);
        if (this.stopped) break;
        if (iter.bestScore <= alpha && alpha > -INF) {
          delta += delta;
          beta = ((alpha + beta) / 2) | 0;
          alpha = iter.bestScore - delta;
          if (alpha < -MATE) alpha = -INF;
          continue;
        }
        if (iter.bestScore >= beta && beta < INF) {
          delta += delta;
          beta = iter.bestScore + delta;
          if (beta > MATE) beta = INF;
          continue;
        }
        break;
      }

      // hasil iterasi yang kepotong waktu cuma dipakai kalau langkah pertama
      // (perkiraan terbaik sebelumnya) sudah selesai dihitung
      if (this.stopped && !iter.firstDone) break;

      bestMove = iter.bestMove; bestScore = iter.bestScore;
      for (let i = 0; i < order.length; i++) {
        if (iter.scores[i] !== -INF) scores[i] = iter.scores[i];
      }
      if (!this.stopped) completedDepth = depth;

      // langkah terbaik ke depan buat iterasi berikutnya (ordering = separuh kekuatan)
      const idx = [];
      for (let i = 0; i < order.length; i++) idx.push(i);
      idx.sort((a, b) => scores[b] - scores[a]);
      const bi = order.indexOf(bestMove);
      if (bi >= 0) { idx.splice(idx.indexOf(bi), 1); idx.unshift(bi); }
      const newOrder = [], newScores = new Int32Array(order.length);
      for (let k = 0; k < idx.length; k++) { newOrder.push(order[idx[k]]); newScores[k] = scores[idx[k]]; }
      order = newOrder; scores = newScores;

      if (opts.onIteration) {
        opts.onIteration({ depth, score: bestScore, nodes: this.nodes, timeMs: Date.now() - t0, best: bestMove });
      }
      if (this.stopped) break;
      if (Math.abs(bestScore) >= MATE_IN_MAX) break;  // skakmat paksa: selesai
    }

    // ---- tahap 2: nilai langkah akar lainnya buat badge kualitas ----
    if (gradeAll && order.length > 1) {
      // Dibatasi 400ms: dengan TT yang sudah panas dari pencarian utama, segini
      // lebih dari cukup. Tanpa plafon ini, level Elo tinggi (jatah 2-3 detik)
      // kena tambahan 30% waktu cuma buat angka badge.
      const gradeMs = opts.gradeBudgetMs != null ? opts.gradeBudgetMs
        : Math.min(400, Math.max(40, Math.round(budgetMs * 0.30)));
      this.gradeRootMoves(pos, order, scores, bestMove, bestScore, completedDepth, classMargin, gradeMs);
    }

    const rootMoves = [];
    for (let i = 0; i < order.length; i++) rootMoves.push({ move: order[i], score: scores[i] });
    rootMoves.sort((a, b) => b.score - a.score);
    const j = rootMoves.findIndex(r => r.move === bestMove);
    if (j > 0) { const [r] = rootMoves.splice(j, 1); rootMoves.unshift(r); }

    return {
      best: bestMove,
      score: bestScore,
      depth: completedDepth,
      seldepth: this.seldepth,
      nodes: this.nodes,
      qnodes: this.qnodes,
      timeMs: Date.now() - t0,
      pv: this.extractPv(pos, bestMove),
      rootMoves,
      mate: Math.abs(bestScore) >= MATE_IN_MAX
        ? (bestScore > 0 ? Math.ceil((MATE - bestScore) / 2) : -Math.ceil((MATE + bestScore) / 2))
        : null,
    };
  }

  // Satu iterasi penuh di akar, pakai PVS: langkah pertama jendela penuh,
  // sisanya null-window dulu dan baru di-search ulang kalau ternyata menjanjikan.
  rootIteration(pos, order, depth, alpha, beta) {
    const scores = new Int32Array(order.length).fill(-INF);
    let bestScore = -INF, bestMove = order[0], firstDone = false;
    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      pos.makeMove(m);
      let s;
      if (i === 0) {
        s = -this.negamax(pos, depth - 1, -beta, -alpha, 1, true, m, CHECK_EXT_BUDGET);
      } else {
        s = -this.negamax(pos, depth - 1, -alpha - 1, -alpha, 1, true, m, CHECK_EXT_BUDGET);
        if (s > alpha && s < beta && !this.stopped) {
          s = -this.negamax(pos, depth - 1, -beta, -alpha, 1, true, m, CHECK_EXT_BUDGET);
        }
      }
      pos.unmakeMove();
      if (this.stopped) break;
      scores[i] = s;
      if (i === 0) {
        firstDone = true; bestScore = s; bestMove = m;
        if (s > alpha) alpha = s;
      } else if (s > bestScore) {
        bestScore = s;
        // Langkah pengganti cuma dipakai kalau skornya beneran melewati alpha.
        // Waktu iterasi gagal-rendah (semua langkah di bawah jendela), angka
        // yang dibalikin cuma BATAS ATAS — bukan bukti langkah itu lebih baik,
        // jadi jangan sampai dia menggusur langkah terbaik iterasi sebelumnya.
        if (s > alpha) { alpha = s; bestMove = m; }
      }
    }
    // bestScore = fail-soft terbaik dari langkah yang sudah dicari; dipakai
    // pemanggil buat melebarkan aspiration window kalau ternyata gagal-rendah
    return { scores, bestScore, bestMove, firstDone };
  }

  // Nilai langkah akar selain yang terbaik, buat badge kualitas langkah.
  // Caranya: tiap langkah diuji null-window terhadap (best - margin). Yang lolos
  // di-search ulang biar dapat nilai eksak; yang jeblok cukup ditandai "jauh
  // lebih buruk" — toh badge-nya sama-sama blunder. Hemat waktu, dan karena TT
  // sudah panas dari pencarian utama, ini murah.
  gradeRootMoves(pos, order, scores, bestMove, bestScore, mainDepth, margin, budgetMs) {
    // PENTING: kedalamannya harus SAMA dengan pencarian utama. Kalau langkah
    // pembanding dinilai lebih dangkal, skornya jadi optimis dan "kerugian"
    // langkah kehilangan arti — badge-nya bakal ngaco.
    const depth = Math.max(1, mainDepth);
    const lower = (bestScore > -MATE_IN_MAX ? bestScore : -MATE_IN_MAX) - margin;
    const floor = lower - 1;
    this.deadline = Date.now() + budgetMs;
    this.stopped = false;
    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      if (m === bestMove) { scores[i] = bestScore; continue; }
      if (this.stopped) { if (scores[i] === -INF || scores[i] > bestScore) scores[i] = floor; continue; }
      pos.makeMove(m);
      let s = -this.negamax(pos, depth - 1, -lower - 1, -lower, 1, true, m, CHECK_EXT_BUDGET);
      if (s > lower && !this.stopped) {
        s = -this.negamax(pos, depth - 1, -INF, -lower, 1, true, m, CHECK_EXT_BUDGET);
      }
      pos.unmakeMove();
      if (this.stopped) { if (scores[i] === -INF || scores[i] > bestScore) scores[i] = floor; continue; }
      // langkah terbaik dihitung lebih dalam, jadi nggak boleh ada langkah lain
      // yang "kelihatan" lebih bagus cuma karena dinilai lebih dangkal
      scores[i] = s > bestScore ? bestScore : s;
    }
    const bi = order.indexOf(bestMove);
    if (bi >= 0) scores[bi] = bestScore;
  }

  ttProbeMove(pos) {
    const i = this.ttProbe(pos.keyA, pos.keyB);
    return i >= 0 ? this.ttMove[i] : 0;
  }

  // Ambil jalur utama (principal variation) dari TT — buat ditampilkan/di-debug.
  extractPv(pos, firstMove) {
    const pv = [];
    if (!firstMove) return pv;
    let made = 0;
    let m = firstMove;
    for (let i = 0; i < 24; i++) {
      if (!m) break;
      // pastikan langkahnya legal di posisi sekarang
      const n = pos.generate(60, false);
      let ok = false;
      for (let k = 0; k < n; k++) if (pos.moveBuf[60 * MOVES_PER_PLY + k] === m) { ok = true; break; }
      if (!ok || !pos.makeMove(m)) break;
      pv.push(m); made++;
      const ti = this.ttProbe(pos.keyA, pos.keyB);
      m = ti >= 0 ? this.ttMove[ti] : 0;
    }
    for (let i = 0; i < made; i++) pos.unmakeMove();
    return pv;
  }
}

const CHECK_EXT_BUDGET = 10;
const QUIET_SCRATCH = [];

module.exports = { Searcher, INF, MATE, MATE_IN_MAX, TT_EXACT, TT_LOWER, TT_UPPER };
