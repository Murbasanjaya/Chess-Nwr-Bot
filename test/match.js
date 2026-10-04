'use strict';
// Uji kekuatan relatif: level yang lebih tinggi harus beneran mengalahkan level
// yang lebih rendah. Ini yang memastikan "angka Elo" di UI bukan cuma hiasan,
// dan sekaligus uji ketahanan: partai penuh dimainkan sampai habis, semua
// langkah harus legal dan permainannya harus berakhir normal.

const { Chess } = require('chess.js');
const engine = require('../engine/chessEngine.js');

const STRONG = { maxDepth: 9, budget: 200, blunder: 0, top: 1, noise: 0 };
const WEAK = { maxDepth: 2, budget: 40, blunder: .40, top: 6, noise: 220 };
const GAMES = 6;
const MAX_PLY = 120;
// pembuka berbeda biar partainya nggak kembar
const OPENINGS = [['e4', 'e5'], ['d4', 'd5'], ['e4', 'c5'], ['Nf3', 'd5'], ['c4', 'e5'], ['d4', 'Nf6']];
const VALS = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function material(g) {
  let s = 0;
  for (const row of g.board()) for (const c of row) if (c && c.type !== 'k') s += (c.color === 'w' ? 1 : -1) * VALS[c.type];
  return s;
}

function playGame(strongIsWhite, openingIdx) {
  const g = new Chess();
  for (const san of OPENINGS[openingIdx % OPENINGS.length]) g.move(san);
  while (!g.game_over() && g.history().length < MAX_PLY) {
    const strongTurn = (g.turn() === 'w') === strongIsWhite;
    const cfg = strongTurn ? STRONG : WEAK;
    const scored = engine.findBestMoves(g.fen(), cfg.maxDepth, cfg.budget, {
      sanHistory: g.history(), classMargin: cfg.blunder > 0 ? 700 : 240,
    });
    if (!scored.length) throw new Error('engine nggak kasih langkah di ' + g.fen());
    const idx = engine.pickMove(scored, cfg);
    const chosen = scored[idx].m;
    // semua langkah harus legal menurut chess.js
    const legal = g.moves({ verbose: true })
      .some(l => l.from === chosen.from && l.to === chosen.to && (l.promotion || null) === (chosen.promotion || null));
    if (!legal) throw new Error('langkah ilegal ' + chosen.san + ' di ' + g.fen());
    g.move(chosen);
  }
  if (g.in_checkmate()) return { winner: ((g.turn() === 'w') !== strongIsWhite) ? 'strong' : 'weak', reason: 'skakmat', plies: g.history().length };
  if (g.in_draw() || g.in_stalemate() || g.in_threefold_repetition()) return { winner: null, reason: 'seri aturan', plies: g.history().length };
  const m = material(g);
  const adv = strongIsWhite ? m : -m;
  if (adv >= 5) return { winner: 'strong', reason: 'adjudikasi materi +' + adv, plies: g.history().length };
  if (adv <= -5) return { winner: 'weak', reason: 'adjudikasi materi ' + adv, plies: g.history().length };
  return { winner: null, reason: 'seri adjudikasi (materi ' + adv + ')', plies: g.history().length };
}

let strongWin = 0, weakWin = 0, draw = 0;
const t0 = Date.now();
for (let i = 0; i < GAMES; i++) {
  const r = playGame(i % 2 === 0, i);
  if (r.winner === 'strong') strongWin++; else if (r.winner === 'weak') weakWin++; else draw++;
  console.log(`partai ${i + 1}: level kuat main ${i % 2 === 0 ? 'putih' : 'hitam'} -> ` +
    `${r.winner === 'strong' ? 'KUAT MENANG' : r.winner === 'weak' ? 'LEMAH MENANG' : 'seri'} (${r.reason}, ${r.plies} langkah)`);
}
const score = (strongWin + draw * 0.5) / GAMES;
console.log(`\nlevel kuat: ${strongWin} menang, ${draw} seri, ${weakWin} kalah ` +
  `-> skor ${(score * 100).toFixed(0)}% (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

const MIN = 0.70;
if (score < MIN) { console.log(`GAGAL ❌ level kuat cuma dapat ${(score * 100).toFixed(0)}%, minimal ${MIN * 100}%`); process.exit(1); }
console.log(`LULUS ✅ level tinggi jelas lebih kuat dari level rendah`);
