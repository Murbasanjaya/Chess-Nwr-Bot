// Catur Kayu — server Node.js/Express.
// Semua "otak" AI jalan di sini (server), bukan di browser — jadi HP/device kamu
// nggak perlu mikir berat sama sekali, tinggal render papan & kirim/terima langkah.

const express = require('express');
const path = require('path');
const engine = require('./engine/chessEngine.js');
const {
  Chess, findBestMoves, analyze, eloConfig, pickMove, classifyMove, gradePlayedMove,
  detectOpening, bookMove, OPENINGS, MATE_THRESHOLD,
} = engine;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Badge kualitas langkah pakai KEDALAMAN TETAP, bukan jatah waktu tetap: biar
// langkah yang sama selalu dapat badge yang sama, nggak berubah-ubah cuma gara-gara
// server-nya pas lebih sibuk atau tabel transposisinya lebih panas.
const CLASSIFY_DEPTH = 10;
const CLASSIFY_MS = 900;      // jaring pengaman kalau posisinya luar biasa ramai
const HINT_DEPTH = 16;
const HINT_MS = 900;

// ---------- helper: convert a chess.js verbose move object to the small shape the client needs ----------
function slimMove(m) {
  return { from: m.from, to: m.to, promotion: m.promotion || null, san: m.san, captured: m.captured || null, flags: m.flags };
}

// Ringkasan skor buat ditampilkan ke pemain: "+1.5" atau "skakmat 3".
function scoreText(score, mate) {
  if (mate !== null && mate !== undefined) {
    return mate > 0 ? ('skakmat dalam ' + mate) : ('dimat dalam ' + (-mate));
  }
  const p = (score / 100).toFixed(2);
  return (score > 0 ? '+' : '') + p;
}

// ---------- POST /api/bot-move ----------
// body: { fen, sanHistory: string[], elo }
// -> { move: {from,to,promotion,san}, source: 'book'|'engine', tag, opening, info }
app.post('/api/bot-move', (req, res) => {
  try {
    const { fen, sanHistory, elo } = req.body;
    if (!fen) return res.status(400).json({ error: 'fen wajib diisi' });
    const history = Array.isArray(sanHistory) ? sanHistory : [];
    const game = new Chess(fen);
    if (game.game_over && game.game_over()) return res.status(400).json({ error: 'permainan sudah selesai' });

    const eloNum = Math.max(400, Math.min(5000, parseInt(elo, 10) || 1200));
    const opening = detectOpening(history);

    // 1) coba buku pembukaan dulu
    const bookSan = bookMove(history);
    if (bookSan) {
      const legal = game.moves({ verbose: true });
      const found = legal.find(m => m.san === bookSan);
      if (found) {
        game.move(found);
        return res.json({
          move: slimMove(found),
          source: 'book',
          tag: { tier: 'book', label: 'Buku', chip: '📖' },
          opening: detectOpening(history.concat([found.san])) || opening
        });
      }
    }

    // 2) kalau tidak ada di buku (atau sudah lewat), hitung sendiri
    const cfg = eloConfig(eloNum);
    const scored = findBestMoves(fen, cfg.maxDepth, cfg.budget, {
      sanHistory: history,
      // Level bawah butuh skor semua langkah dengan resolusi lebar (biar
      // "kesalahan manusiawi"-nya bisa dipilih dengan terukur) — dan itu murah
      // karena kedalamannya kecil. Level atas cuma butuh cukup buat badge.
      classMargin: cfg.blunder > 0 ? 700 : 240,
    });
    if (!scored || scored.length === 0) return res.status(400).json({ error: 'tidak ada langkah legal' });

    const chosenIdx = pickMove(scored, cfg);
    const chosen = scored[chosenIdx].m;
    const plyNumber = history.length + 1;
    const tag = classifyMove(scored, chosenIdx, plyNumber, fen);
    game.move(chosen);

    const info = scored.info || {};
    res.json({
      move: slimMove(chosen),
      source: 'engine',
      depthReached: info.depth || cfg.maxDepth,
      tag,
      opening: detectOpening(history.concat([chosen.san])) || opening,
      info: {
        depth: info.depth, seldepth: info.seldepth, nodes: info.nodes,
        nps: info.nps, timeMs: info.timeMs,
        score: scored[chosenIdx].s,
        scoreText: scoreText(scored[chosenIdx].s, info.mate),
        mate: info.mate,
        level: cfg.tag,
        forcedMate: scored[0].s >= MATE_THRESHOLD,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: String(err && err.message || err) });
  }
});

// ---------- POST /api/classify ----------
// body: { fenBefore, move: {from,to,promotion}, sanHistory (SUDAH termasuk langkah ini) }
// -> { tag, opening, loss, bestMove }
app.post('/api/classify', (req, res) => {
  try {
    const { fenBefore, move, sanHistory } = req.body;
    if (!fenBefore || !move) return res.status(400).json({ error: 'fenBefore & move wajib diisi' });
    const history = Array.isArray(sanHistory) ? sanHistory : [];
    const graded = gradePlayedMove(fenBefore, move, {
      plyNumber: history.length,
      maxDepth: CLASSIFY_DEPTH,
      budgetMs: CLASSIFY_MS,
      sanHistoryBefore: history.slice(0, -1), // riwayat SEBELUM langkah ini
    });
    res.json({
      tag: graded.tag,
      opening: detectOpening(history),
      loss: graded.loss,
      depth: graded.depth,
      bestMove: graded.best ? slimMove(graded.best) : null,
      scoreText: scoreText(graded.bestScore, graded.mate),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: String(err && err.message || err) });
  }
});

// ---------- POST /api/hint ----------
// body: { fen, sanHistory? }
// -> { move: {from,to,promotion,san,captured}, text, pv, score }
app.post('/api/hint', (req, res) => {
  try {
    const { fen, sanHistory } = req.body;
    if (!fen) return res.status(400).json({ error: 'fen wajib diisi' });
    const r = analyze(fen, {
      maxDepth: HINT_DEPTH, budgetMs: HINT_MS,
      sanHistory: Array.isArray(sanHistory) ? sanHistory : undefined,
    });
    if (!r.best) return res.status(400).json({ error: 'tidak ada langkah legal' });
    const m = r.best;
    const PIECE_NAME = { p: 'Pion', n: 'Kuda', b: 'Gajah', r: 'Benteng', q: 'Menteri', k: 'Raja' };
    let text = 'Saran: ' + PIECE_NAME[m.piece] + ' ' + m.from + ' → ' + m.to;
    if (m.captured) text += ' (makan ' + PIECE_NAME[m.captured] + ')';
    if (m.flags.indexOf('p') !== -1) text += ' (promosi Menteri)';
    if (r.mate !== null && r.mate > 0) text += ' \u2014 skakmat dalam ' + r.mate + '!';
    else if (r.mate !== null) text += ' \u2014 bertahan, dimat dalam ' + (-r.mate);
    else {
      text += ' \u00b7 taksiran ' + scoreText(r.score, null);
      if (r.depth) text += ' \u00b7 dihitung ' + r.depth + ' langkah ke depan';
    }
    res.json({
      move: slimMove(m), text,
      pv: r.pv, score: r.score, scoreText: scoreText(r.score, r.mate),
      mate: r.mate, depth: r.depth, nodes: r.nodes, nps: r.nps,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: String(err && err.message || err) });
  }
});

// ---------- POST /api/analyze ----------
// Analisis lebih dalam buat satu posisi: skor, kedalaman, jalur utama (PV).
// body: { fen, sanHistory?, depth?, ms? }
app.post('/api/analyze', (req, res) => {
  try {
    const { fen, sanHistory, depth, ms } = req.body;
    if (!fen) return res.status(400).json({ error: 'fen wajib diisi' });
    const r = analyze(fen, {
      maxDepth: Math.max(1, Math.min(parseInt(depth, 10) || 20, 48)),
      budgetMs: Math.max(50, Math.min(parseInt(ms, 10) || 2000, 10000)),
      sanHistory: Array.isArray(sanHistory) ? sanHistory : undefined,
    });
    res.json({
      best: r.best ? slimMove(r.best) : null,
      score: r.score, scoreText: scoreText(r.score, r.mate), mate: r.mate,
      depth: r.depth, seldepth: r.seldepth, nodes: r.nodes, nps: r.nps, timeMs: r.timeMs,
      pv: r.pv, staticEval: r.eval,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: String(err && err.message || err) });
  }
});

// ---------- GET /api/openings ----------
// query: ?q=ruy lopez  (opsional, filter nama/eco)
app.get('/api/openings', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  let list = OPENINGS;
  if (q) {
    list = OPENINGS.filter(o => o.name.toLowerCase().includes(q) || o.eco.toLowerCase().includes(q));
  }
  res.json({ count: list.length, total: OPENINGS.length, openings: list });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Catur Kayu jalan di http://localhost:' + PORT);
});
