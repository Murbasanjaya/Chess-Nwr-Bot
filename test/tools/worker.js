'use strict';
// Proses pekerja: memainkan beberapa partai antara dua "pemain" lalu
// melapor hasilnya ke proses induk lewat IPC. Tiap pekerja = satu core.
const path = require('path');
const { Chess } = require('chess.js');
const { UciEngine } = require('./uci.js');

const loaded = new Map();
function ourEngine(dir) {
  const d = path.resolve(dir || path.join(__dirname, '..', '..', 'engine'));
  if (!loaded.has(d)) loaded.set(d, require(path.join(d, 'chessEngine.js')));
  return loaded.get(d);
}

async function makePlayer(spec) {
  if (spec.type === 'sf') {
    const e = new UciEngine({ elo: spec.elo, skill: spec.skill, hashMb: 16 });
    await e.init();
    return {
      spec, newGame: () => e.newGame(), quit: () => e.quit(),
      move: async g => {
        const u = await e.bestMove(g.fen(), spec.ms || 200, spec.depth);
        return { from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined };
      },
    };
  }
  const E = ourEngine(spec.dir);
  // konfigurasi: kekuatan s, Elo (lewat eloConfig), atau angka eksplisit
  let cfg;
  if (spec.s != null && E.strengthParams) cfg = E.strengthParams(spec.s);
  else if (spec.elo) cfg = E.eloConfig(spec.elo);
  else cfg = { maxDepth: 64, budget: spec.ms || 500, blunder: 0, noise: 0 };
  if (spec.ms) cfg.budget = spec.ms;
  if (spec.nodes) cfg.nodes = spec.nodes;
  if (spec.cfg) Object.assign(cfg, spec.cfg);
  return {
    spec, newGame: async () => {}, quit: () => {},
    move: async g => {
      let scored, idx = 0;
      if (E.botSearch && (cfg.nodes || cfg.noise || cfg.blunder)) ({ scored, idx } = E.botSearch(g.fen(), cfg, g.history()));
      else {
        scored = E.findBestMoves(g.fen(), cfg.maxDepth, cfg.budget, { sanHistory: g.history(), classMargin: 240 });
        idx = E.pickMove ? E.pickMove(scored, cfg) : 0;
      }
      const m = scored[idx].m;
      return { from: m.from, to: m.to, promotion: m.promotion || undefined };
    },
  };
}

async function playGame(white, black, opening, maxPly) {
  const g = new Chess();
  for (const m of opening.moves) g.move(m);
  await white.newGame(); await black.newGame();
  while (!g.game_over() && g.history().length < maxPly) {
    const p = g.turn() === 'w' ? white : black;
    const mv = await p.move(g);
    if (!g.move(mv)) throw new Error('langkah ilegal ' + JSON.stringify(mv) + ' @ ' + g.fen());
  }
  if (g.in_checkmate()) return { result: g.turn() === 'w' ? 0 : 1, reason: 'mate', plies: g.history().length, pgn: g.pgn() };
  return { result: 0.5, reason: g.game_over() ? 'draw' : 'maxply', plies: g.history().length, pgn: g.pgn() };
}

process.on('message', async job => {
  const A = await makePlayer(job.a), B = await makePlayer(job.b);
  for (const t of job.games) {
    const white = t.aWhite ? A : B, black = t.aWhite ? B : A;
    let r;
    try { r = await playGame(white, black, t.opening, job.maxPly || 300); }
    catch (e) { process.send({ error: String(e && e.stack || e) }); continue; }
    const aScore = t.aWhite ? r.result : 1 - r.result;
    process.send({ game: t.id, aWhite: t.aWhite, aScore, reason: r.reason, plies: r.plies, pgn: job.savePgn ? r.pgn : undefined });
  }
  A.quit(); B.quit();
  process.send({ done: true });
  setTimeout(() => process.exit(0), 300);
});
