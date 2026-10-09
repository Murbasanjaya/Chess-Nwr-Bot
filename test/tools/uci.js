'use strict';
// Pembungkus engine UCI (Stockfish) sebagai child process. Dipakai HANYA di
// alat ukur/kalibrasi — aplikasinya sendiri nggak pernah memanggil Stockfish.
const { spawn } = require('child_process');
const path = require('path');

const SF_PATH = path.join(__dirname, '..', '..', 'node_modules', 'stockfish', 'bin', 'stockfish-19-single.js');

class UciEngine {
  constructor(opts) {
    this.opts = opts || {};
    this.proc = spawn(process.execPath, [SF_PATH], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = '';
    this.waiters = [];
    this.proc.stdout.on('data', d => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        for (const w of this.waiters.slice()) {
          if (w.test(line)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(line); }
        }
      }
    });
  }
  send(cmd) { this.proc.stdin.write(cmd + '\n'); }
  waitFor(re) { return new Promise(resolve => this.waiters.push({ test: l => re.test(l), resolve })); }
  async init() {
    this.send('uci');
    await this.waitFor(/^uciok/);
    const o = this.opts;
    if (o.hashMb) this.send('setoption name Hash value ' + o.hashMb);
    if (o.elo) {
      this.send('setoption name UCI_LimitStrength value true');
      this.send('setoption name UCI_Elo value ' + o.elo);
    }
    if (o.skill != null) this.send('setoption name Skill Level value ' + o.skill);
    this.send('isready');
    await this.waitFor(/^readyok/);
  }
  async newGame() { this.send('ucinewgame'); this.send('isready'); await this.waitFor(/^readyok/); }
  async bestMove(fen, movetime, depth) {
    this.send('position fen ' + fen);
    this.send(depth ? ('go depth ' + depth) : ('go movetime ' + movetime));
    const line = await this.waitFor(/^bestmove/);
    return line.split(/\s+/)[1];
  }
  quit() { try { this.send('quit'); } catch (e) { /* abaikan */ } setTimeout(() => { try { this.proc.kill(); } catch (e) { /* */ } }, 200); }
}
module.exports = { UciEngine };
