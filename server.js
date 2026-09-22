// Catur Kayu — server Node.js/Express.
// Semua "otak" AI jalan di sini (server), bukan di browser — jadi HP/device kamu
// nggak perlu mikir berat sama sekali, tinggal render papan & kirim/terima langkah.

const express = require('express');
const path = require('path');
const engine = require('./engine/chessEngine.js');
const { Chess, findBestMoves, eloConfig, classifyMove, detectOpening, bookMove, OPENINGS } = engine;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helper: convert a chess.js verbose move object to the small shape the client needs ----------
function slimMove(m){
  return { from: m.from, to: m.to, promotion: m.promotion || null, san: m.san, captured: m.captured || null, flags: m.flags };
}

// ---------- POST /api/bot-move ----------
// body: { fen, sanHistory: string[], elo }
// -> { move: {from,to,promotion,san}, source: 'book'|'engine', tag, opening }
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
    const scored = findBestMoves(fen, cfg.maxDepth, cfg.budget);
    if (!scored || scored.length === 0) return res.status(400).json({ error: 'tidak ada langkah legal' });

    let chosenIdx;
    const forcedMateFound = scored[0].s > 50000;
    if (forcedMateFound) {
      chosenIdx = 0; // jangan pernah acak-acak skakmat yang sudah ketemu
    } else if (Math.random() < cfg.blunder) {
      const worseStart = Math.max(1, Math.ceil(scored.length / 2));
      const pool = scored.slice(worseStart);
      chosenIdx = pool.length ? worseStart + Math.floor(Math.random() * pool.length) : scored.length - 1;
    } else {
      const topN = Math.min(cfg.top, scored.length);
      chosenIdx = Math.floor(Math.random() * topN);
    }
    const chosen = scored[chosenIdx].m;
    const plyNumber = history.length + 1;
    const tag = classifyMove(scored, chosenIdx, plyNumber);
    game.move(chosen);

    res.json({
      move: slimMove(chosen),
      source: 'engine',
      depthReached: cfg.maxDepth,
      tag,
      opening: detectOpening(history.concat([chosen.san])) || opening
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: String(err && err.message || err) });
  }
});

// ---------- POST /api/classify ----------
// body: { fenBefore, move: {from,to,promotion}, sanHistory (SUDAH termasuk langkah ini) }
// -> { tag, opening }
app.post('/api/classify', (req, res) => {
  try {
    const { fenBefore, move, sanHistory } = req.body;
    if (!fenBefore || !move) return res.status(400).json({ error: 'fenBefore & move wajib diisi' });
    const history = Array.isArray(sanHistory) ? sanHistory : [];
    const scored = findBestMoves(fenBefore, 3, 200);
    let tag = { tier: 'good', label: '', chip: '' };
    if (scored && scored.length) {
      const idx = scored.findIndex(s => s.m.from === move.from && s.m.to === move.to && (s.m.promotion||null) === (move.promotion||null));
      tag = classifyMove(scored, idx < 0 ? scored.length - 1 : idx, history.length);
    }
    res.json({ tag, opening: detectOpening(history) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: String(err && err.message || err) });
  }
});

// ---------- POST /api/hint ----------
// body: { fen }
// -> { move: {from,to,promotion,san,captured}, text }
app.post('/api/hint', (req, res) => {
  try {
    const { fen } = req.body;
    if (!fen) return res.status(400).json({ error: 'fen wajib diisi' });
    const scored = findBestMoves(fen, 4, 700);
    if (!scored || !scored.length) return res.status(400).json({ error: 'tidak ada langkah legal' });
    const m = scored[0].m;
    const PIECE_NAME = { p: 'Pion', n: 'Kuda', b: 'Gajah', r: 'Benteng', q: 'Menteri', k: 'Raja' };
    let text = 'Saran: ' + PIECE_NAME[m.piece] + ' ' + m.from + ' \u2192 ' + m.to;
    if (m.captured) text += ' (makan ' + PIECE_NAME[m.captured] + ')';
    if (m.flags.indexOf('p') !== -1) text += ' (promosi Menteri)';
    res.json({ move: slimMove(m), text });
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
