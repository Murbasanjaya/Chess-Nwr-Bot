'use strict';
// Membuat kumpulan posisi buat tuning evaluasi: self-play cepat dengan sedikit
// variasi acak, lalu ambil sampel posisi "tenang" (nggak lagi skak, langkah
// terbaiknya bukan makan/promosi). Label nilainya nanti dari Stockfish (label.js).
//
//   node test/tools/genpos.js <jumlah-partai> <file-keluaran> [pekerja]
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.argv[2] === '--child') {
  const { Position, MCAP, MPROMO, isEP, moveToUci } = require('../../engine/position.js');
  const { Searcher } = require('../../engine/search.js');
  const { openingFens } = require('./openings.js');
  const { Chess } = require('chess.js');
  const ops = openingFens(2);
  process.on('message', ({ games, seed }) => {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const searcher = new Searcher(1 << 17);
    const out = [];
    for (let gi = 0; gi < games; gi++) {
      const op = ops[Math.floor(rnd() * ops.length)];
      const g = new Chess();
      for (const m of op.moves) g.move(m);
      let lopsided = 0;
      for (let ply = g.history().length; ply < 260 && !g.game_over(); ply++) {
        const pos = new Position().setFen(g.fen());
        const early = ply < 14;
        const r = searcher.searchRoot(pos, {
          maxDepth: early ? 2 : 6, budgetMs: 1e9, nodeLimit: early ? undefined : 1500,
          gradeAll: early, classMargin: 60,
        });
        if (!r.best) break;
        let move = r.best;
        if (early) {
          // variasi pembuka: pilih acak di antara langkah yang selisihnya kecil
          const ok = r.rootMoves.filter(x => r.rootMoves[0].score - x.score <= 40);
          move = ok[Math.floor(rnd() * ok.length)].move;
        } else if (rnd() < 0.1 && r.rootMoves.length > 1) {
          // sesekali langkah kedua terbaik, biar posisinya beragam
          const alt = r.rootMoves[1];
          if (r.rootMoves[0].score - alt.score <= 60) move = alt.move;
        }
        const quiet = !MCAP(r.best) && !isEP(r.best) && !MPROMO(r.best) && !pos.inCheck();
        if (!early && quiet && Math.abs(r.score) < 2500 && rnd() < 0.6) out.push(g.fen());
        lopsided = Math.abs(r.score) > 1200 ? lopsided + 1 : 0;
        if (lopsided >= 6) break; // sudah jelas menang/kalah, posisi sisanya kurang informatif
        const u = moveToUci(move);
        if (!g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })) throw new Error('ilegal ' + u);
      }
      if (out.length >= 200) { process.send({ fens: out.splice(0) }); }
    }
    process.send({ fens: out, done: true });
  });
  return;
}

const total = parseInt(process.argv[2] || '100', 10);
const file = process.argv[3] || 'positions.txt';
const workers = parseInt(process.argv[4] || String(os.cpus().length), 10);
const fd = fs.openSync(file, 'a');
let count = 0, finished = 0;
const t0 = Date.now();
for (let w = 0; w < workers; w++) {
  const child = fork(__filename, ['--child'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.on('message', m => {
    if (m.fens.length) { fs.writeSync(fd, m.fens.join('\n') + '\n'); count += m.fens.length; }
    if (m.done) {
      finished++;
      child.kill();
      if (finished === workers) {
        fs.closeSync(fd);
        console.log(`${count} posisi dari ${total} partai dalam ${Math.round((Date.now() - t0) / 1000)}s`);
      }
    }
  });
  child.send({ games: Math.ceil(total / workers), seed: 1000 + w * 7919 + Date.now() % 1000 });
}
