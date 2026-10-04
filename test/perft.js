'use strict';
// Uji perft: hitung jumlah node persis pada posisi-posisi standar yang
// jawabannya sudah diketahui luas. Kalau satu angka saja beda, berarti ada bug
// di generator langkah (castling, en passant, promosi, pin, dll) — dan engine
// yang generatornya salah pasti main ngaco. Ini jaring pengaman utama.

const { Position, MOVES_PER_PLY } = require('../engine/position.js');

function perft(pos, depth, ply) {
  if (depth === 0) return 1;
  const n = pos.generate(ply, false);
  const base = ply * MOVES_PER_PLY;
  // salin dulu: buffer ply ini bakal dipakai ulang di rekursi anak
  const moves = pos.moveBuf.slice(base, base + n);
  let nodes = 0;
  for (let i = 0; i < n; i++) {
    if (!pos.makeMove(moves[i])) continue;
    nodes += depth === 1 ? 1 : perft(pos, depth - 1, ply + 1);
    pos.unmakeMove();
  }
  return nodes;
}

const SUITES = [
  { name: 'startpos', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    expect: [20, 400, 8902, 197281, 4865609] },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    expect: [48, 2039, 97862, 4085603] },
  { name: 'pos3 (ep + benteng)', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    expect: [14, 191, 2812, 43238, 674624] },
  { name: 'pos4 (promosi)', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    expect: [6, 264, 9467, 422333] },
  { name: 'pos4 mirror', fen: 'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1',
    expect: [6, 264, 9467, 422333] },
  { name: 'pos5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    expect: [44, 1486, 62379, 2103487] },
  { name: 'pos6', fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    expect: [46, 2079, 89890, 3894594] },
];

let fail = 0, totalNodes = 0;
const t0 = Date.now();
for (const s of SUITES) {
  for (let d = 1; d <= s.expect.length; d++) {
    const pos = new Position().setFen(s.fen);
    const t = Date.now();
    const got = perft(pos, d, 0);
    const want = s.expect[d - 1];
    totalNodes += got;
    const ok = got === want;
    if (!ok) fail++;
    const ms = Date.now() - t;
    console.log(`${ok ? 'OK  ' : 'GAGAL'} ${s.name} depth ${d}: ${got}` +
      (ok ? '' : ` (harusnya ${want})`) +
      ` [${ms}ms${ms > 50 ? ', ' + Math.round(got / ms / 1000) + 'M node/s' : ''}]`);
    // posisi harus kembali persis seperti semula setelah semua make/unmake
    if (pos.fen() !== s.fen) { console.log('  GAGAL: papan tidak pulih -> ' + pos.fen()); fail++; }
  }
}
const dt = (Date.now() - t0) / 1000;
console.log(`\nTotal ${totalNodes.toLocaleString('en-US')} node dalam ${dt.toFixed(1)}s ` +
  `(${(totalNodes / dt / 1e6).toFixed(2)}M node/detik)`);
console.log(fail === 0 ? 'SEMUA PERFT LULUS ✅' : `${fail} PERFT GAGAL ❌`);
process.exit(fail === 0 ? 0 : 1);
