'use strict';
// Uji kebenaran engine. Bukan uji "kuat atau nggak", tapi uji "salah atau nggak":
//
//  1. Evaluasi simetris    — posisi yang dicerminkan harus bernilai persis minus
//                            nilai aslinya. Kalau nggak, ada bug sisi/warna.
//  2. Oracle skakmat        — pencarian buta exhaustive (tanpa pemangkasan sama
//                            sekali) dipakai sebagai pembanding independen:
//                            engine harus setuju soal ADA/TIDAKNYA skakmat paksa
//                            dan jumlah langkahnya.
//  3. Legalitas             — semua langkah yang dipilih engine harus langkah
//                            legal menurut chess.js, di banyak posisi acak.
//  4. Konsistensi penilaian — skor langkah akar dibandingkan dengan pencarian
//                            terpisah per langkah di kedalaman yang sama.
//  5. Kesadaran seri        — engine tahu posisi ulangan & materi tak cukup.

const { Chess } = require('chess.js');
const { Position, MOVES_PER_PLY, moveToUci } = require('../engine/position.js');
const { evaluate } = require('../engine/evaluate.js');
const { Searcher, MATE_IN_MAX } = require('../engine/search.js');
const engine = require('../engine/chessEngine.js');

let fail = 0;
function check(ok, label, detail) {
  if (!ok) { fail++; console.log('GAGAL ' + label + (detail ? ' -> ' + detail : '')); }
  else console.log('OK    ' + label + (detail ? ' (' + detail + ')' : ''));
}

// ---------------- 1. simetri evaluasi ----------------
function mirrorFen(fen) {
  const [b, s, c, ep, hm, fm] = fen.split(/\s+/);
  const rows = b.split('/').reverse().map(r => r.split('').map(ch => {
    if (ch >= '1' && ch <= '8') return ch;
    return ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
  }).join(''));
  const cc = c === '-' ? '-' : c.split('').map(x => x === x.toLowerCase() ? x.toUpperCase() : x.toLowerCase()).sort().join('');
  const epp = ep === '-' ? '-' : ep[0] + String(9 - parseInt(ep[1], 10));
  return rows.join('/') + ' ' + (s === 'w' ? 'b' : 'w') + ' ' + cc + ' ' + epp + ' ' + (hm || 0) + ' ' + (fm || 1);
}

const EVAL_FENS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r1bq1r1k/1pp2pbp/p1np2p1/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 10',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
  '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
  '8/8/8/4k3/8/8/4K3/7Q w - - 0 1',
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b Kkq - 1 2',
];
{
  let bad = 0;
  for (const f of EVAL_FENS) {
    const a = evaluate(new Position().setFen(f));
    const b = evaluate(new Position().setFen(mirrorFen(f)));
    if (a + b !== 0) { bad++; console.log('   asimetris: ' + f + ' -> ' + a + ' / ' + b); }
  }
  check(bad === 0, 'evaluasi simetris di ' + EVAL_FENS.length + ' posisi');
}

// ---------------- 2. oracle skakmat (exhaustive, tanpa pemangkasan) ----------------
function legalMoves(pos, ply) {
  const n = pos.generate(ply, false);
  const base = ply * MOVES_PER_PLY;
  return pos.moveBuf.slice(base, base + n);
}
// Bisakah pihak yang jalan memaksa skakmat dalam `plies` setengah-langkah?
function canForceMate(pos, plies, ply) {
  if (plies <= 0) return false;
  for (const m of legalMoves(pos, ply)) {
    if (!pos.makeMove(m)) continue;
    // apakah lawan sekarang skakmat?
    let replies = 0;
    const oppMoves = legalMoves(pos, ply + 1);
    for (const r of oppMoves) { if (pos.makeMove(r)) { replies++; pos.unmakeMove(); break; } }
    if (replies === 0) {
      const mated = pos.inCheck();
      pos.unmakeMove();
      if (mated) return true;
      continue; // stalemate, bukan skakmat
    }
    if (plies >= 3) {
      // SEMUA balasan lawan harus tetap berujung skakmat
      let all = true;
      for (const r of legalMoves(pos, ply + 1)) {
        if (!pos.makeMove(r)) continue;
        const ok = canForceMate(pos, plies - 2, ply + 2);
        pos.unmakeMove();
        if (!ok) { all = false; break; }
      }
      if (all) { pos.unmakeMove(); return true; }
    }
    pos.unmakeMove();
  }
  return false;
}
function oracleMateIn(fen, maxN) {
  for (let nMoves = 1; nMoves <= maxN; nMoves++) {
    const pos = new Position().setFen(fen);
    if (canForceMate(pos, nMoves * 2 - 1, 0)) return nMoves;
  }
  return null;
}

const MATE_FENS = [
  ['benteng baris belakang', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 2],
  ['raja+menteri vs raja', 'k7/8/1K6/8/8/8/8/1Q6 w - - 0 1', 2],
  ['menteri+gajah', 'r1b2k1r/ppp1bppp/8/1B1Q4/8/8/PPPB1PPP/R3K2R w KQ - 1 1', 3],
  ['skakmat 2 langkah', '5rk1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1', 3],
  ['tanpa mate paksa', 'r1bq1r1k/1pp2pbp/p1np2p1/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 10', 2],
  ['posisi awal', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 2],
  ['raja+benteng vs raja', '8/8/8/4k3/8/8/8/R3K3 w - - 0 1', 2],
];
for (const [name, fen, maxN] of MATE_FENS) {
  const truth = oracleMateIn(fen, maxN);
  const r = engine.analyze(fen, { maxDepth: 20, budgetMs: 1500 });
  const got = r.mate !== null && r.mate > 0 ? r.mate : null;
  const ok = truth === got;
  check(ok, 'oracle skakmat: ' + name,
    'oracle=' + (truth === null ? 'tidak ada' : 'mate ' + truth) +
    ', engine=' + (got === null ? 'tidak ada' : 'mate ' + got) +
    (got ? ', langkah ' + (r.best ? r.best.san : '?') : '') + ', depth ' + r.depth);
}

// ---------------- 3. legalitas langkah di posisi acak ----------------
{
  let bad = 0, tested = 0;
  // mainkan beberapa partai acak, lalu minta engine jalan dari posisi apa pun
  for (let g = 0; g < 12; g++) {
    const game = new Chess();
    let seed = 12345 + g * 7919;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let move = 0; move < 60 && !game.game_over(); move++) {
      const legal = game.moves({ verbose: true });
      // tiap beberapa langkah, cek engine
      if (move % 7 === 0) {
        const scored = engine.findBestMoves(game.fen(), 6, 120);
        tested++;
        const legalKeys = new Set(legal.map(l => l.from + l.to + (l.promotion || '')));
        if (!scored.length) { bad++; console.log('   engine nggak balikin langkah: ' + game.fen()); continue; }
        if (scored.length !== legal.length) {
          bad++; console.log('   jumlah langkah beda: engine ' + scored.length + ' vs chess.js ' + legal.length + ' @ ' + game.fen());
        }
        for (const s of scored) {
          if (!legalKeys.has(s.m.from + s.m.to + (s.m.promotion || ''))) {
            bad++; console.log('   langkah ilegal: ' + s.m.san + ' @ ' + game.fen());
          }
        }
      }
      game.move(legal[Math.floor(rnd() * legal.length)]);
    }
  }
  check(bad === 0, 'semua langkah engine legal & lengkap (' + tested + ' posisi diuji)');
}

// ---------------- 4. kualitas & konsistensi penilaian langkah ----------------
// Pembandingnya: tiap langkah dicari sendiri-sendiri, Searcher terpisah (TT
// sendiri), kedalaman sama. Yang diuji BUKAN kecocokan angka persis — search
// dengan pemangkasan heuristik memang nggak pernah persis sama kalau jendela &
// TT-nya beda. Yang diuji: keputusannya benar, dan nggak ada langkah buruk yang
// dinilai nyaris terbaik (ini yang bikin badge kualitas langkah jadi ngaco).
{
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  const DEPTH = 6;
  const truth = new Map();
  {
    const pos = new Position().setFen(fen);
    const n = pos.generate(0, false);
    const moves = pos.moveBuf.slice(0, n);
    for (const m of moves) {
      if (!pos.makeMove(m)) continue;
      const s = new Searcher(1 << 16);
      const r = s.searchRoot(pos, { maxDepth: DEPTH - 1, budgetMs: 60000, gradeAll: false });
      pos.unmakeMove();
      truth.set(moveToUci(m), -r.score);
    }
  }
  const bestTruth = Math.max(...truth.values());
  // margin raksasa = semua langkah dinilai eksak; jatah penilaian juga harus
  // longgar, kalau nggak sebagian langkah cuma kebagian batas-atas
  const scored = engine.findBestMoves(fen, DEPTH, 60000, { classMargin: 100000, gradeBudgetMs: 60000 });
  const key = sc => sc.m.from + sc.m.to + (sc.m.promotion || '');

  // a) langkah yang dipilih engine harus memang bagus secara objektif
  const pickedTruth = truth.get(key(scored[0]));
  check(pickedTruth >= bestTruth - 50, 'langkah pilihan engine objektif bagus',
    scored[0].m.san + ': pembanding ' + pickedTruth + ' vs terbaik ' + bestTruth);

  // b) peringkat engine harus sejalan dengan peringkat pembanding.
  // Patokannya relatif ke sebaran posisi itu sendiri, bukan angka absolut:
  // di posisi tertentu langkah terbaik ke-5 memang sudah rugi 200cp lebih, dan
  // itu sifat posisinya — bukan kesalahan engine.
  const sortedTruth = [...truth.values()].sort((a, b) => b - a);
  let rankViolation = 0, rankDetail = '';
  for (let k = 0; k < Math.min(5, scored.length); k++) {
    const t = truth.get(key(scored[k]));
    if (t === undefined) continue;
    const allowed = sortedTruth[k] - 100; // toleransi: search dengan pemangkasan heuristik nggak pernah persis sama
    if (t < allowed) {
      rankViolation++;
      if (!rankDetail) rankDetail = 'peringkat ' + (k + 1) + ' ' + scored[k].m.san +
        ': pembanding ' + t + ', seharusnya >= ' + allowed;
    }
  }
  check(rankViolation === 0, 'peringkat lima langkah teratas sejalan dengan pembanding',
    rankViolation ? rankDetail : 'peringkat 1-5 cocok');

  // c) nggak ada langkah jelek yang dinilai "nyaris terbaik" oleh engine
  let mislabeled = 0, example = '';
  for (const sc of scored) {
    const t = truth.get(key(sc));
    if (t === undefined) continue;
    if (scored[0].s - sc.s <= 50 && bestTruth - t >= 300) {
      mislabeled++; if (!example) example = sc.m.san + ' (engine ' + sc.s + ', pembanding ' + t + ')';
    }
  }
  check(mislabeled === 0, 'nggak ada langkah buruk yang dinilai nyaris terbaik',
    mislabeled ? example : 'dari ' + scored.length + ' langkah');

  // d) deterministik: dua pencarian identik harus memberi hasil identik —
  // langkah, skor, SAMPAI jumlah node-nya. Kalau jumlah node beda, berarti ada
  // keputusan yang bergantung jam dinding di jalur yang seharusnya murni
  // dibatasi kedalaman.
  const opt = { maxDepth: 8, budgetMs: 60000, gradeAll: false };
  const a = new Searcher(1 << 18).searchRoot(new Position().setFen(fen), opt);
  const b = new Searcher(1 << 18).searchRoot(new Position().setFen(fen), opt);
  check(a.best === b.best && a.score === b.score && a.nodes === b.nodes,
    'pencarian deterministik (hasil bisa diulang)',
    moveToUci(a.best) + '/' + a.score + '/' + a.nodes + ' vs ' + moveToUci(b.best) + '/' + b.score + '/' + b.nodes);

  // e) badge kualitas langkah juga harus bisa diulang: dengan kedalaman tetap
  // dan jatah penilaian yang cukup, dua panggilan harus memberi badge sama.
  const move = { from: 'd5', to: 'd6' };
  const g1 = engine.gradePlayedMove(fen, move, { plyNumber: 20, maxDepth: 8, budgetMs: 20000 });
  const g2 = engine.gradePlayedMove(fen, move, { plyNumber: 20, maxDepth: 8, budgetMs: 20000 });
  check(g1.tag.tier === g2.tag.tier && g1.loss === g2.loss,
    'penilaian langkah bisa diulang',
    g1.tag.label + '/rugi ' + g1.loss + ' vs ' + g2.tag.label + '/rugi ' + g2.loss);
}

// ---------------- 5. kesadaran seri ----------------
{
  // materi tak cukup: raja+gajah vs raja = seri, skornya harus ~0
  const r = engine.analyze('8/8/4k3/8/8/2KB4/8/8 w - - 0 1', { maxDepth: 10, budgetMs: 300 });
  check(Math.abs(r.score) < 60, 'K+B vs K dinilai seri', 'skor ' + r.score);

  // posisi ulangan: engine harus sadar langkah yang mengulang = seri.
  // Hitam cuma punya raja lawan raja+menteri: semua langkah berujung kalah,
  // skornya harus negatif besar buat hitam (bukan 0 alias "aman").
  const r2 = engine.analyze('7k/8/8/8/8/8/8/K6Q b - - 0 1', { maxDepth: 12, budgetMs: 600 });
  check(r2.score < -400, 'raja sendirian vs menteri dinilai kalah', 'skor ' + r2.score);
}

// ---------------- 6. level Elo ----------------
{
  const info = engine.eloInfo();
  let mono = true, prev = null, detail = '';
  for (let elo = info.min; elo <= info.max; elo += 50) {
    const c = engine.eloConfig(elo);
    if (prev && (c.nodes < prev.nodes || c.noise > prev.noise || c.blunder > prev.blunder)) {
      mono = false; if (!detail) detail = 'Elo ' + elo + ' lebih lemah dari Elo ' + prev.elo;
    }
    prev = c;
  }
  check(mono, 'level Elo makin tinggi = makin kuat (monoton)', detail || (info.min + '–' + info.max));
  check(info.min >= 300 && info.max <= 3200 && info.min < info.max, 'rentang Elo masuk akal',
    info.min + '–' + info.max + (info.measured ? ' (hasil kalibrasi)' : ' (BELUM dikalibrasi)'));
  // angka di luar rentang dijepit, bukan dipakai mentah-mentah
  check(engine.eloConfig(99999).elo === info.max && engine.eloConfig(1).elo === info.min, 'Elo di luar rentang dijepit');

  // Regresi: langkah yang skornya belum dinilai tuntas (exact:false) nggak
  // boleh pernah terpilih — dulu skor perkiraannya nyaris sama dengan langkah
  // terbaik, jadi level berderau malah sering blunder (terukur: -500 Elo).
  const fake = [
    { m: 'terbaik', s: 50, exact: true },
    { m: 'belum-dinilai', s: 49, exact: false },
    { m: 'bagus', s: 30, exact: true },
    { m: 'blunder-tak-dikenal', s: -200, exact: false },
  ];
  let picked = 0;
  for (let i = 0; i < 2000; i++) {
    const idx = engine.pickMove(fake, { noise: 300, blunder: 0.5 });
    if (fake[idx].exact === false) picked++;
  }
  check(picked === 0, 'langkah yang belum dinilai tuntas nggak pernah dipilih', picked + ' dari 2000 undian');
}

console.log('');
console.log(fail === 0 ? 'SEMUA UJI KEBENARAN LULUS ✅' : fail + ' UJI GAGAL ❌');
process.exit(fail === 0 ? 0 : 1);
