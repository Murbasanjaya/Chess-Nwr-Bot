'use strict';
// Memberi label nilai ke tiap posisi pakai Stockfish (kedalaman tetap).
// Keluaran per baris: "<fen>;<skor cp dari sudut pandang PUTIH>"
//   node test/tools/label.js <masukan> <keluaran> [kedalaman] [pekerja]
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const SF_PATH = path.join(__dirname, '..', '..', 'node_modules', 'stockfish', 'bin', 'stockfish-19-single.js');
const [inFile, outFile] = process.argv.slice(2, 4);
const depth = parseInt(process.argv[4] || '8', 10);
const workers = parseInt(process.argv[5] || String(os.cpus().length), 10);

const fens = fs.readFileSync(inFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const done = new Set();
if (fs.existsSync(outFile)) {
  for (const l of fs.readFileSync(outFile, 'utf8').split('\n')) if (l) done.add(l.split(';')[0]);
}
const todo = fens.filter(f => !done.has(f));
const fd = fs.openSync(outFile, 'a');
let next = 0, labeled = 0;
const t0 = Date.now();

function runWorker() {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [SF_PATH], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', cur = null, lastScore = null;
    const send = c => p.stdin.write(c + '\n');
    const nextJob = () => {
      if (next >= todo.length) { send('quit'); setTimeout(() => { p.kill(); resolve(); }, 100); return; }
      cur = todo[next++]; lastScore = null;
      send('position fen ' + cur);
      send('go depth ' + depth);
    };
    p.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.startsWith('uciok')) { send('setoption name Hash value 16'); send('isready'); }
        else if (line.startsWith('readyok')) nextJob();
        else if (line.startsWith('info') && line.includes(' score ') && !line.includes('bound')) {
          const m = line.match(/score (cp|mate) (-?\d+)/);
          if (m) lastScore = m[1] === 'cp' ? parseInt(m[2], 10) : (parseInt(m[2], 10) > 0 ? 3000 : -3000);
        } else if (line.startsWith('bestmove')) {
          if (lastScore !== null) {
            const white = cur.split(' ')[1] === 'w' ? lastScore : -lastScore;
            fs.writeSync(fd, cur + ';' + white + '\n');
            labeled++;
            if (labeled % 5000 === 0) {
              const r = labeled / ((Date.now() - t0) / 1000);
              console.log(`${labeled}/${todo.length} (${r.toFixed(0)}/s, sisa ~${Math.round((todo.length - labeled) / r)}s)`);
            }
          }
          nextJob();
        }
      }
    });
    send('uci');
  });
}
Promise.all(Array.from({ length: workers }, runWorker)).then(() => {
  fs.closeSync(fd);
  console.log(`selesai: ${labeled} posisi dilabel dalam ${Math.round((Date.now() - t0) / 1000)}s`);
});
