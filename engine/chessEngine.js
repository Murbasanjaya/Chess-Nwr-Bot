// Engine catur buatan sendiri — jalan sepenuhnya di server (Node.js).
// Minimax + alpha-beta + quiescence search + evaluasi posisional (material, PST,
// struktur pion, pasangan gajah) + buku pembukaan. Tidak pakai Stockfish atau
// library engine pihak ketiga — cuma chess.js buat aturan main (legalitas langkah).

const { Chess } = require('chess.js');
const OPENINGS = require('../data/openings.js');

// ---------------- nilai bidak & piece-square tables ----------------
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const PST = {
  p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5,
      0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30,
      -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30,
      -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10,
      -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10,
      -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
      -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10,
      -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10,
      -20,-10,-10,-5,-5,-10,-10,-20],
  k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10,
      20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20]
};

function pieceValueOf(type){ return VAL[type] || 0; }

function absoluteEval(g){
  const board = g.board();
  let score = 0;
  const pawnFilesW = [0,0,0,0,0,0,0,0], pawnFilesB = [0,0,0,0,0,0,0,0];
  let bishopsW = 0, bishopsB = 0;
  for(let row=0; row<8; row++){
    for(let col=0; col<8; col++){
      const cell = board[row][col];
      if(!cell) continue;
      const idx = row*8+col;
      const tbl = PST[cell.type];
      if(cell.color === 'w'){
        score += VAL[cell.type] + tbl[idx];
        if(cell.type === 'p') pawnFilesW[col]++;
        else if(cell.type === 'b') bishopsW++;
      } else {
        const mIdx = (7-row)*8+col;
        score -= VAL[cell.type] + tbl[mIdx];
        if(cell.type === 'p') pawnFilesB[col]++;
        else if(cell.type === 'b') bishopsB++;
      }
    }
  }
  for(let f=0; f<8; f++){
    if(pawnFilesW[f]>1) score -= 16*(pawnFilesW[f]-1);
    if(pawnFilesB[f]>1) score += 16*(pawnFilesB[f]-1);
    if(pawnFilesW[f]>0 && !(f>0&&pawnFilesW[f-1]>0) && !(f<7&&pawnFilesW[f+1]>0)) score -= 12*pawnFilesW[f];
    if(pawnFilesB[f]>0 && !(f>0&&pawnFilesB[f-1]>0) && !(f<7&&pawnFilesB[f+1]>0)) score += 12*pawnFilesB[f];
  }
  if(bishopsW>=2) score += 30;
  if(bishopsB>=2) score -= 30;
  return score;
}

// ---------------- search: quiescence + negamax + alpha-beta, time-boxed ----------------
const ABORT = Symbol('abort');
let nodeCheckCounter = 0;
function timeUp(deadline){
  if((nodeCheckCounter = (nodeCheckCounter+1) & 1023) === 0){
    if(Date.now() > deadline) throw ABORT;
  }
}

function quiescence(g, alpha, beta, deadline, qLeft){
  timeUp(deadline);
  if(g.in_checkmate()) return -100000;
  const standPat = (g.turn()==='w'?1:-1) * absoluteEval(g);
  if(standPat >= beta) return beta;
  if(alpha < standPat) alpha = standPat;
  if(qLeft <= 0) return alpha;
  let moves = g.moves({verbose:true}).filter(m => m.captured || m.flags.indexOf('p')!==-1);
  moves.sort((a,b)=>{ const av=a.captured?pieceValueOf(a.captured):0; const bv=b.captured?pieceValueOf(b.captured):0; return bv-av; });
  for(const m of moves){
    g.move(m);
    let score;
    try{ score = -quiescence(g, -beta, -alpha, deadline, qLeft-1); }
    catch(e){ g.undo(); throw e; }
    g.undo();
    if(score >= beta) return beta;
    if(score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(g, depth, alpha, beta, deadline){
  if(g.in_checkmate()) return -100000 - depth;
  if(g.in_draw() || g.in_stalemate() || g.in_threefold_repetition()) return 0;
  if(depth === 0) return quiescence(g, alpha, beta, deadline, 4);
  timeUp(deadline);
  let moves = g.moves({verbose:true});
  moves.sort((a,b)=>{ const av=a.captured?pieceValueOf(a.captured):0; const bv=b.captured?pieceValueOf(b.captured):0; return bv-av; });
  let best = -Infinity;
  for(const m of moves){
    g.move(m);
    let score;
    try{ score = -negamax(g, depth-1, -beta, -alpha, deadline); }
    catch(e){ g.undo(); throw e; }
    g.undo();
    if(score > best) best = score;
    if(best > alpha) alpha = best;
    if(alpha >= beta) break;
  }
  return best;
}

// Iterative deepening bounded by wall-clock time. Runs fully synchronously —
// on the server this is fine, it doesn't freeze anyone's browser; only this
// one HTTP request waits on it.
function findBestMoves(fen, maxDepth, budgetMs){
  const deadline = Date.now() + budgetMs;
  const g = new Chess(fen);
  let overallBest = null, pv = null, depth = 1;
  while(depth <= maxDepth && Date.now() < deadline){
    const rootMoves = g.moves({verbose:true});
    if(rootMoves.length === 0) break;
    rootMoves.sort((a,b)=>{
      const aPV = pv && a.from===pv.from && a.to===pv.to && a.promotion===pv.promotion;
      const bPV = pv && b.from===pv.from && b.to===pv.to && b.promotion===pv.promotion;
      if(aPV && !bPV) return -1; if(bPV && !aPV) return 1;
      const av=a.captured?pieceValueOf(a.captured):0, bv=b.captured?pieceValueOf(b.captured):0;
      return bv-av;
    });
    const scored = [];
    let aborted = false;
    for(const m of rootMoves){
      g.move(m);
      let s;
      try{ s = -negamax(g, depth-1, -Infinity, Infinity, deadline); }
      catch(e){
        g.undo();
        if(e===ABORT){ aborted = true; break; }
        throw e;
      }
      g.undo();
      scored.push({ m, s });
    }
    if(aborted) break;
    scored.sort((a,b)=>b.s-a.s);
    overallBest = scored;
    pv = scored[0].m;
    depth++;
  }
  if(!overallBest){
    // budget ran out before even depth 1 finished (shouldn't normally happen) — just grade every legal move at depth 0
    const g2 = new Chess(fen);
    const rootMoves = g2.moves({verbose:true});
    overallBest = rootMoves.map(m=>{
      g2.move(m);
      const s = -((g2.turn()==='w'?1:-1) * absoluteEval(g2));
      g2.undo();
      return {m, s};
    }).sort((a,b)=>b.s-a.s);
  }
  return overallBest;
}

// ---------------- strength tiers ----------------
function eloConfig(elo){
  if(elo<700)  return {maxDepth:2, budget:150, blunder:.40, top:5, tag:'Pemula — asal jalan, sering blunder'};
  if(elo<1000) return {maxDepth:2, budget:250, blunder:.25, top:4, tag:'Santai — mikir sebentar, kadang meleset'};
  if(elo<1300) return {maxDepth:3, budget:400, blunder:.15, top:3, tag:'Menengah — sesekali meleset'};
  if(elo<1600) return {maxDepth:4, budget:600, blunder:.08, top:2, tag:'Cukup kuat — jarang blunder'};
  if(elo<1900) return {maxDepth:4, budget:900, blunder:.04, top:2, tag:'Kuat — mulai menghitung taktik beberapa langkah'};
  if(elo<2200) return {maxDepth:5, budget:1300, blunder:.015, top:1, tag:'Ahli — jeli baca kombinasi'};
  if(elo<2600) return {maxDepth:6, budget:1800, blunder:0, top:1, tag:'Master — mengincar celah taktik & kombinasi menang'};
  if(elo<3200) return {maxDepth:7, budget:2400, blunder:0, top:1, tag:'Grandmaster — menghitung dalam, memburu skakmat'};
  if(elo<4000) return {maxDepth:8, budget:3000, blunder:0, top:1, tag:'Super GM — sangat sulit dikalahkan'};
  return {maxDepth:10, budget:3800, blunder:0, top:1, tag:'Maksimal — menghitung sangat dalam, mengejar skakmat begitu ada celah'};
}

// ---------------- klasifikasi kualitas langkah ----------------
function classifyMove(scored, playedIdx, plyNumber){
  if(plyNumber<=6) return {tier:'book', label:'Buku', chip:'📖'};
  const best = scored[0].s;
  const played = scored[playedIdx].s;
  const loss = best - played;
  const isBest = playedIdx === 0;
  if(isBest){
    const m = scored[0].m;
    const second = scored.length>1 ? scored[1].s : best;
    const gap = best - second;
    if(m.captured && pieceValueOf(m.piece) > pieceValueOf(m.captured)+150 && gap>=60) return {tier:'brilliant', label:'Brilian', chip:'💎'};
    if(gap>=180) return {tier:'great', label:'Hebat', chip:'⭐'};
    return {tier:'best', label:'Terbaik', chip:'✓'};
  }
  if(loss<45) return {tier:'good', label:'Baik', chip:'✓'};
  if(loss<110) return {tier:'inacc', label:'Kurang Tepat', chip:'?!'};
  if(loss<260) return {tier:'mistake', label:'Salah', chip:'?'};
  return {tier:'blunder', label:'BAD', chip:'??'};
}

// ---------------- buku pembukaan ----------------
// history: array SAN dari langkah pertama, misal ['e4','e5','Nf3']
function detectOpening(history){
  let bestMatch = null;
  for(const entry of OPENINGS){
    if(entry.moves.length > history.length) continue;
    let match = true;
    for(let i=0;i<entry.moves.length;i++){ if(entry.moves[i] !== history[i]){ match=false; break; } }
    if(match && (!bestMatch || entry.moves.length > bestMatch.moves.length)) bestMatch = entry;
  }
  return bestMatch ? { eco: bestMatch.eco, name: bestMatch.name, counter: bestMatch.counter } : null;
}

const BOOK_PLY_LIMIT = 14; // stop consulting the book after this many half-moves
function bookMove(history){
  if(history.length >= BOOK_PLY_LIMIT) return null;
  const candidates = [];
  for(const entry of OPENINGS){
    if(entry.moves.length <= history.length) continue;
    let match = true;
    for(let i=0;i<history.length;i++){ if(entry.moves[i] !== history[i]){ match=false; break; } }
    if(match) candidates.push(entry.moves[history.length]);
  }
  if(candidates.length === 0) return null;
  return candidates[Math.floor(Math.random()*candidates.length)]; // SAN string
}

module.exports = {
  Chess, VAL, absoluteEval, findBestMoves, eloConfig, classifyMove,
  detectOpening, bookMove, pieceValueOf, BOOK_PLY_LIMIT, OPENINGS
};
