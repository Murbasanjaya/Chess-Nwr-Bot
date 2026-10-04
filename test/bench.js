'use strict';
// Benchmark kecepatan. Dipakai buat ngecek kalau ada perubahan yang bikin
// engine melambat (regresi), dan buat tahu kedalaman realistis per jatah waktu.

const { Position, MOVES_PER_PLY } = require('../engine/position.js');
const { evaluate } = require('../engine/evaluate.js');
const { Searcher } = require('../engine/search.js');
const { moveToUci } = require('../engine/position.js');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const POSITIONS = [
  ['posisi awal', START],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['tengah permainan', 'r1bq1r1k/1pp2pbp/p1np2p1/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 10'],
  ['endgame pion', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'],
];

function perft(pos, depth, ply) {
  if (depth === 0) return 1;
  const n = pos.generate(ply, false);
  const base = ply * MOVES_PER_PLY;
  const moves = pos.moveBuf.slice(base, base + n);
  let nodes = 0;
  for (let i = 0; i < n; i++) {
    if (!pos.makeMove(moves[i])) continue;
    nodes += depth === 1 ? 1 : perft(pos, depth - 1, ply + 1);
    pos.unmakeMove();
  }
  return nodes;
}

console.log('--- komponen ---');
{
  const pos = new Position().setFen('r1bq1r1k/1pp2pbp/p1np2p1/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 10');
  for (let i = 0; i < 20000; i++) evaluate(pos); // pemanasan JIT
  const N = 300000, t = Date.now();
  let x = 0;
  for (let i = 0; i < N; i++) x += evaluate(pos);
  const dt = Date.now() - t;
  console.log(`evaluasi      : ${(N / dt / 1000).toFixed(2)}M per detik (${(dt * 1000 / N).toFixed(2)}us tiap posisi)`);

  const p2 = new Position().setFen(START);
  const t2 = Date.now();
  const nodes = perft(p2, 5, 0);
  const dt2 = Date.now() - t2;
  console.log(`generate+make : ${(nodes / dt2 / 1000).toFixed(2)}M langkah per detik (perft 5 = ${nodes})`);
}

console.log('\n--- kedalaman per jatah waktu (satu Searcher, TT dipakai ulang) ---');
const rows = [];
for (const [name, fen] of POSITIONS) {
  const line = [];
  for (const ms of [100, 300, 1000, 3000]) {
    const s = new Searcher(1 << 20);
    const pos = new Position().setFen(fen);
    const r = s.searchRoot(pos, { maxDepth: 64, budgetMs: ms, gradeAll: false });
    line.push({ ms, depth: r.depth, seldepth: r.seldepth, nps: Math.round(r.nodes / Math.max(1, r.timeMs) * 1000), best: moveToUci(r.best) });
  }
  rows.push([name, line]);
  console.log(name.padEnd(18) + line.map(l => `${l.ms}ms: d${l.depth}/sel${l.seldepth} (${Math.round(l.nps / 1000)}k nps)`).join('  |  '));
}

console.log('\n--- level Elo ---');
const engine = require('../engine/chessEngine.js');
for (const elo of [400, 800, 1200, 1600, 2000, 2400, 2800, 3600, 5000]) {
  const cfg = engine.eloConfig(elo);
  const t = Date.now();
  const scored = engine.findBestMoves(START, cfg.maxDepth, cfg.budget, { classMargin: cfg.blunder > 0 ? 700 : 240 });
  const dt = Date.now() - t;
  console.log(`Elo ${String(elo).padStart(4)}: depth ${String(scored.info.depth).padStart(2)} (batas ${String(cfg.maxDepth).padStart(2)}), ${String(dt).padStart(4)}ms total, ${scored.info.nodes} node`);
}

// Jaring pengaman regresi: kalau kecepatannya jatuh drastis, uji ini gagal.
const startRow = rows[0][1].find(l => l.ms === 1000);
const MIN_DEPTH = 9;
if (startRow.depth < MIN_DEPTH) {
  console.log(`\nREGRESI ❌ posisi awal cuma sampai depth ${startRow.depth} dalam 1000ms (minimal ${MIN_DEPTH})`);
  process.exit(1);
}
console.log(`\nOK ✅ posisi awal sampai depth ${startRow.depth} dalam 1000ms (minimal ${MIN_DEPTH})`);
