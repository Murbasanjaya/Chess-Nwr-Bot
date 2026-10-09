'use strict';
// Pertandingan paralel A vs B, hasilnya selisih Elo + rentang ketidakpastian.
//
//   node test/tools/gauntlet.js --a '{"type":"ours","ms":500}' --b '{"type":"sf","elo":2000}' --games 40
//
// Pemain:
//   {"type":"ours", "elo":1600}            level dari eloConfig engine kita
//   {"type":"ours", "ms":500, "dir":"..."} jatah waktu tetap, folder engine lain (A/B test)
//   {"type":"sf", "elo":1800, "ms":200}    Stockfish dengan UCI_Elo resmi (1320-3190)
const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const { openingFens } = require('./openings.js');

function parseArgs() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  return o;
}

// Selisih Elo dari skor, plus rentang 95% (pendekatan normal pada skor rata-rata)
function eloStats(scores) {
  const n = scores.length;
  const mean = scores.reduce((x, y) => x + y, 0) / n;
  const variance = scores.reduce((x, y) => x + (y - mean) * (y - mean), 0) / n;
  const se = Math.sqrt(variance / n);
  const toElo = s => { const c = Math.min(0.999, Math.max(0.001, s)); return -400 * Math.log10(1 / c - 1); };
  return { n, score: mean, elo: toElo(mean), lo: toElo(mean - 1.96 * se), hi: toElo(mean + 1.96 * se) };
}

async function run(opts) {
  const games = parseInt(opts.games || '20', 10);
  const workers = Math.min(parseInt(opts.workers || String(os.cpus().length), 10), games);
  const ops = openingFens(4);
  // urutan pembuka diacak tapi deterministik per seed
  let seed = parseInt(opts.seed || '7', 10);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const order = ops.map((o, i) => [rnd(), i]).sort((x, y) => x[0] - y[0]).map(x => ops[x[1]]);
  const tasks = [];
  for (let i = 0; i < games; i++) tasks.push({ id: i, aWhite: i % 2 === 0, opening: order[Math.floor(i / 2) % order.length] });
  const chunks = Array.from({ length: workers }, () => []);
  // pasangan (warna ditukar) di pekerja yang sama — urutan rapi
  tasks.forEach((t, i) => chunks[Math.floor(i / 2) % workers].push(t));

  const a = JSON.parse(opts.a), b = JSON.parse(opts.b);
  const scores = [], reasons = {};
  let w = 0, d = 0, l = 0;
  const t0 = Date.now();
  await Promise.all(chunks.map(chunk => new Promise(resolve => {
    if (!chunk.length) return resolve();
    // NODE_PATH: supaya salinan engine di folder lain (A/B test) tetap bisa require('chess.js')
    const env = Object.assign({}, process.env, { NODE_PATH: path.join(__dirname, '..', '..', 'node_modules') });
    const child = fork(path.join(__dirname, 'worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env });
    child.on('message', m => {
      if (m.error) { console.error('ERROR', m.error); return; }
      if (m.done) return;
      scores.push(m.aScore);
      if (m.aScore === 1) w++; else if (m.aScore === 0) l++; else d++;
      reasons[m.reason] = (reasons[m.reason] || 0) + 1;
      if (opts.verbose) console.log(`  partai ${m.game}: A ${m.aWhite ? 'putih' : 'hitam'} -> ${m.aScore} (${m.reason}, ${m.plies} ply)`);
    });
    child.on('exit', resolve);
    child.send({ a, b, games: chunk, maxPly: parseInt(opts.maxply || '300', 10) });
  })));
  const st = eloStats(scores);
  const res = { a, b, w, d, l, ...st, reasons, seconds: Math.round((Date.now() - t0) / 1000) };
  return res;
}

function fmt(r) {
  const s = v => (v >= 0 ? '+' : '') + Math.round(v);
  return `A ${r.w}M ${r.d}S ${r.l}K dari ${r.n} | skor ${(r.score * 100).toFixed(1)}% | ` +
    `Elo A-B ${s(r.elo)} [${s(r.lo)} .. ${s(r.hi)}] | ${r.seconds}s | ${JSON.stringify(r.reasons)}`;
}

if (require.main === module) {
  run(parseArgs()).then(r => { console.log(fmt(r)); console.log('JSON ' + JSON.stringify(r)); });
}
module.exports = { run, fmt, eloStats };
