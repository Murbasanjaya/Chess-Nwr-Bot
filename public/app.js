(function(){
  "use strict";

  if(typeof Chess === 'undefined'){
    document.querySelector('.app').innerHTML = '<div class="card"><h2>Gagal memuat</h2><p style="font-size:14px;">Library catur (chess.js) gagal dimuat dari CDN. Cek koneksi internet lalu muat ulang halaman.</p></div>';
    return;
  }

  function loadPref(k, fallback){ try{ const v = localStorage.getItem(k); return v===null? fallback : v; }catch(e){ return fallback; } }
  function savePref(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }

  async function api(path, body){
    const res = await fetch(path, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body||{})
    });
    if(!res.ok){ const t = await res.text(); throw new Error('API '+path+' gagal: '+t); }
    return res.json();
  }
  async function apiGet(path){
    const res = await fetch(path);
    if(!res.ok) throw new Error('API '+path+' gagal');
    return res.json();
  }

  const game = new Chess();
  let selected = null, legalTargets = [];
  let botThinking = false, gameOverFlag = false;
  let moveLog = [];
  let pieceEls = new Map();
  let pieceState = [];
  let history = [];
  let humanColor = 'w', botColor = 'b';
  let flipped = false;
  let hintMode = false;
  let audioCtx = null;
  let lastMoveObj = null;
  let lastSuggestionMove = null;
  let currentOpening = null;

  const boardEl = document.getElementById('board');
  const pieceLayer = document.getElementById('pieceLayer');
  const clickLayer = document.getElementById('clickLayer');
  const badgeLayer = document.getElementById('badgeLayer');
  const statusPill = document.getElementById('statusPill');
  const openingPill = document.getElementById('openingPill');
  const openingDesc = document.getElementById('openingDesc');
  const historyList = document.getElementById('historyList');
  const eloSlider = document.getElementById('eloSlider');
  const eloVal = document.getElementById('eloVal');
  const eloTag = document.getElementById('eloTag');
  const playerNameInput = document.getElementById('playerNameInput');
  const botNameInput = document.getElementById('botNameInput');
  const sideSelect = document.getElementById('sideSelect');
  const nameBottom = document.getElementById('nameBottom');
  const nameTop = document.getElementById('nameTop');
  const subTop = document.getElementById('subTop');
  const dotTop = document.getElementById('dotTop');
  const dotBottom = document.getElementById('dotBottom');
  const capTop = document.getElementById('capTop');
  const capBottom = document.getElementById('capBottom');
  const advTop = document.getElementById('advTop');
  const advBottom = document.getElementById('advBottom');
  const avatarTop = document.getElementById('avatarTop');
  const avatarBottom = document.getElementById('avatarBottom');
  const hintToggle = document.getElementById('hintToggle');
  const hintText = document.getElementById('hintText');
  const playHintBtn = document.getElementById('playHintBtn');
  const modalOverlay = document.getElementById('modalOverlay');
  const modalEmoji = document.getElementById('modalEmoji');
  const modalTitle = document.getElementById('modalTitle');
  const modalSub = document.getElementById('modalSub');
  const libOverlay = document.getElementById('libOverlay');
  const libList = document.getElementById('libList');
  const libSub = document.getElementById('libSub');
  const libSearch = document.getElementById('libSearch');

  const PIECE_SYMBOL = {p:'pc-p',n:'pc-n',b:'pc-b',r:'pc-r',q:'pc-q',k:'pc-k'};
  const PIECE_NAME = {p:'Pion',n:'Kuda',b:'Gajah',r:'Benteng',q:'Menteri',k:'Raja'};
  const POINTS = {p:1,n:3,b:3,r:5,q:9};
  function pieceSvg(type){ return '<svg class="piece-svg" viewBox="0 0 45 45"><use href="#'+PIECE_SYMBOL[type]+'"></use></svg>'; }

  // purely cosmetic labels mirroring the server's strength tiers (no engine logic here)
  function eloTagText(elo){
    if(elo<700)  return 'Pemula — asal jalan, sering blunder';
    if(elo<1000) return 'Santai — mikir sebentar, kadang meleset';
    if(elo<1300) return 'Menengah — sesekali meleset';
    if(elo<1600) return 'Cukup kuat — jarang blunder';
    if(elo<1900) return 'Kuat — mulai menghitung taktik beberapa langkah';
    if(elo<2200) return 'Ahli — jeli baca kombinasi';
    if(elo<2600) return 'Master — mengincar celah taktik & kombinasi menang';
    if(elo<3200) return 'Grandmaster — menghitung dalam, memburu skakmat';
    if(elo<4000) return 'Super GM — sangat sulit dikalahkan';
    return 'Maksimal — menghitung sangat dalam, mengejar skakmat begitu ada celah';
  }

  // ---------- sound ----------
  function ensureAudio(){
    if(!audioCtx){ try{ audioCtx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} }
    if(audioCtx && audioCtx.state==='suspended'){ audioCtx.resume(); }
  }
  function beep(freq, dur, type, vol, delay){
    if(!audioCtx) return;
    vol = vol===undefined?0.16:vol; delay = delay||0; type = type||'sine';
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol, t0+0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0+dur+0.03);
  }
  function sndMove(){ beep(520,0.09,'triangle',0.14); }
  function sndCapture(){ beep(300,0.06,'square',0.17); beep(170,0.13,'square',0.14,0.05); }
  function sndCheck(){ beep(880,0.11,'sine',0.18); beep(700,0.14,'sine',0.15,0.09); }
  function sndWin(){ [523,659,784,1047].forEach((f,i)=>beep(f,0.2,'triangle',0.2,i*0.13)); }
  function sndLose(){ [420,350,280].forEach((f,i)=>beep(f,0.24,'sawtooth',0.14,i*0.16)); }
  function sndDraw(){ beep(440,0.16,'sine',0.14); beep(440,0.16,'sine',0.12,0.19); }

  // ---------- board geometry with flip support ----------
  const FILES = ['a','b','c','d','e','f','g','h'];
  function squareAt(row,col){ return FILES[col] + (8-row); }
  function boardRowCol(square){
    const file = square.charCodeAt(0)-97;
    const rank = parseInt(square[1],10);
    return {row:8-rank, col:file};
  }
  function visualRowCol(square){
    let {row,col} = boardRowCol(square);
    if(flipped){ row = 7-row; col = 7-col; }
    return {row,col};
  }
  function physicalToSquare(row,col){ return flipped ? squareAt(7-row,7-col) : squareAt(row,col); }

  const squareEls = {};
  const rankLabelEls = [];
  for(let row=0; row<8; row++){
    for(let col=0; col<8; col++){
      const d = document.createElement('div');
      d.className = 'sq ' + (((row+col)%2===0)?'light':'dark');
      if(col===0){
        const lab = document.createElement('div');
        lab.className='sq-label';
        d.appendChild(lab);
        rankLabelEls[row] = lab;
      }
      boardEl.appendChild(d);
      squareEls[row+'_'+col] = d;

      const c = document.createElement('div');
      c.className = 'click-sq';
      c.dataset.row = row; c.dataset.col = col;
      c.addEventListener('click', ()=>{ ensureAudio(); onSquareClick(physicalToSquare(row,col)); });
      clickLayer.appendChild(c);
    }
  }
  function getEl(square){ const {row,col} = visualRowCol(square); return squareEls[row+'_'+col]; }
  function refreshOrientation(){
    for(let row=0; row<8; row++){
      const sq = physicalToSquare(row,0);
      if(rankLabelEls[row]) rankLabelEls[row].textContent = sq[1];
    }
  }

  // ---------- piece model ----------
  let pieceIdCounter = 1;
  function initPieceState(){
    pieceState = [];
    const board = game.board();
    for(let row=0; row<8; row++) for(let col=0; col<8; col++){
      const cell = board[row][col];
      if(cell) pieceState.push({id:'p'+(pieceIdCounter++), type:cell.type, color:cell.color, square:squareAt(row,col)});
    }
  }
  function renderAllPieces(){
    pieceLayer.innerHTML = '';
    pieceEls.clear();
    pieceState.forEach(p=>{
      const el = document.createElement('div');
      el.className = 'piece ' + p.color;
      el.innerHTML = pieceSvg(p.type) + (p.type!=='k' ? '<div class="pval">'+POINTS[p.type]+'</div>' : '');
      positionPieceEl(el, p.square);
      el.dataset.square = p.square;
      el.addEventListener('click', (e)=>{ e.stopPropagation(); ensureAudio(); onSquareClick(p.square); });
      pieceLayer.appendChild(el);
      pieceEls.set(p.id, el);
    });
  }
  function positionPieceEl(el, square){
    const {row,col} = visualRowCol(square);
    el.style.left = (col*12.5)+'%';
    el.style.top = (row*12.5)+'%';
  }

  function applyMoveToPieces(m){
    let capSquare = m.to;
    if(m.flags.indexOf('e')!==-1){
      const {row,col} = boardRowCol(m.to);
      const capRow = m.color==='w' ? row+1 : row-1;
      capSquare = squareAt(capRow,col);
    }
    let wasCapture = false;
    if(m.flags.indexOf('c')!==-1 || m.flags.indexOf('e')!==-1){
      const capPiece = pieceState.find(p=>p.square===capSquare && p.color!==m.color);
      if(capPiece){
        wasCapture = true;
        const el = pieceEls.get(capPiece.id);
        if(el){ el.classList.add('removing'); setTimeout(()=>{ el.remove(); }, 260); }
        pieceState = pieceState.filter(p=>p.id!==capPiece.id);
        pieceEls.delete(capPiece.id);
      }
    }
    const mover = pieceState.find(p=>p.square===m.from && p.color===m.color);
    if(mover){
      mover.square = m.to;
      if(m.flags.indexOf('p')!==-1){ mover.type = m.promotion || 'q'; }
      const el = pieceEls.get(mover.id);
      if(el){
        positionPieceEl(el, m.to);
        el.dataset.square = m.to;
        if(m.flags.indexOf('p')!==-1){
          el.innerHTML = pieceSvg(mover.type) + '<div class="pval">'+POINTS[mover.type]+'</div>';
        }
        el.classList.add('bump');
        setTimeout(()=>el.classList.remove('bump'), 340);
      }
    }
    if(m.flags.indexOf('k')!==-1 || m.flags.indexOf('q')!==-1){
      const rank = m.color==='w' ? '1' : '8';
      let rFrom, rTo;
      if(m.flags.indexOf('k')!==-1){ rFrom='h'+rank; rTo='f'+rank; } else { rFrom='a'+rank; rTo='d'+rank; }
      const rook = pieceState.find(p=>p.square===rFrom && p.color===m.color && p.type==='r');
      if(rook){
        rook.square = rTo;
        const el = pieceEls.get(rook.id);
        if(el){ positionPieceEl(el, rTo); el.dataset.square = rTo; }
      }
    }
    if(wasCapture) sndCapture(); else sndMove();
  }

  function showBadge(square, cls, chip){
    if(!chip) return;
    const {row,col} = visualRowCol(square);
    const wrap = document.createElement('div');
    wrap.className = 'quality-badge';
    wrap.style.left = (col*12.5)+'%';
    wrap.style.top = (row*12.5)+'%';
    const chipEl = document.createElement('div');
    chipEl.className = 'quality-chip ' + cls;
    chipEl.textContent = chip;
    wrap.appendChild(chipEl);
    badgeLayer.appendChild(wrap);
    setTimeout(()=>wrap.remove(), 2200);
  }
  const TIER_CLASS = {brilliant:'qc-brilliant',great:'qc-great',best:'qc-best',book:'qc-book',good:'qc-good',inacc:'qc-inacc',mistake:'qc-mistake',blunder:'qc-blunder'};

  function clearHighlights(){
    Object.values(squareEls).forEach(el=>{
      el.classList.remove('hi-light','hi-dark','last','check');
      el.querySelectorAll('.dot').forEach(d=>d.remove());
    });
  }
  function clearSuggestion(){
    Object.values(squareEls).forEach(el=>el.classList.remove('suggest-from','suggest-to'));
  }
  function paintLastMove(m){ if(!m) return; lastMoveObj = m; [m.from,m.to].forEach(sq=>{ const el=getEl(sq); if(el) el.classList.add('last'); }); }
  function paintCheck(){
    if(game.in_check()){
      const board = game.board(); const turn = game.turn();
      for(let row=0; row<8; row++) for(let col=0; col<8; col++){
        const cell = board[row][col];
        if(cell && cell.type==='k' && cell.color===turn){ getEl(squareAt(row,col)).classList.add('check'); }
      }
    }
  }
  function paintSelection(){
    if(!selected) return;
    const {row,col} = visualRowCol(selected);
    getEl(selected).classList.add(((row+col)%2===0)?'hi-light':'hi-dark');
    legalTargets.forEach(m=>{
      const tEl = getEl(m.to);
      const dot = document.createElement('div');
      dot.className = 'dot' + (m.captured ? ' capture':'');
      tEl.appendChild(dot);
    });
  }

  function currentName(color){
    return color===humanColor ? (playerNameInput.value.trim()||'Kamu') : (botNameInput.value.trim()||'Bot');
  }

  function updateOpeningDisplay(opening){
    if(opening){
      currentOpening = opening;
      openingPill.style.display = 'inline-block';
      openingPill.textContent = opening.eco + ' · ' + opening.name;
      openingDesc.textContent = opening.name + (opening.counter ? (' — ' + opening.counter) : '');
      openingDesc.classList.add('active');
    }
  }

  function updateStatus(){
    let text;
    if(game.in_checkmate()){
      const winnerColor = game.turn()==='w' ? 'b' : 'w';
      text = 'Skakmat — ' + currentName(winnerColor) + ' menang!';
      gameOverFlag = true;
      finishGame(winnerColor===humanColor ? 'win' : 'lose', 'Skakmat');
    } else if(game.in_stalemate()){
      text = 'Seri — buntu (stalemate)'; gameOverFlag = true; finishGame('draw','Stalemate — tidak ada langkah legal');
    } else if(game.in_draw() || game.in_threefold_repetition()){
      text = 'Seri'; gameOverFlag = true; finishGame('draw','Posisi seri');
    } else if(game.in_check()){
      text = currentName(game.turn()) + ' — Skak!';
    } else {
      text = 'Giliran ' + currentName(game.turn());
    }
    statusPill.textContent = text;
    dotBottom.classList.toggle('active', game.turn()===humanColor && !gameOverFlag);
    dotTop.classList.toggle('active', game.turn()===botColor && !gameOverFlag);
  }

  function finishGame(outcome, sub){
    if(outcome==='win'){ modalEmoji.textContent='🎉'; modalTitle.textContent='Selamat, Anda menang!'; sndWin(); }
    else if(outcome==='lose'){ modalEmoji.textContent='😔'; modalTitle.textContent=currentName(botColor)+' menang'; sndLose(); }
    else { modalEmoji.textContent='🤝'; modalTitle.textContent='Seri!'; sndDraw(); }
    modalSub.textContent = sub;
    setTimeout(()=>modalOverlay.classList.add('show'), 500);
  }

  function renderCaptures(){
    const startCount = {p:8,n:2,b:2,r:2,q:1};
    const have = {w:{p:0,n:0,b:0,r:0,q:0}, b:{p:0,n:0,b:0,r:0,q:0}};
    pieceState.forEach(p=>{ if(have[p.color][p.type]!==undefined) have[p.color][p.type]++; });
    let youCaptured=[], botCaptured=[], yourPts=0, botPts=0;
    ['q','r','b','n','p'].forEach(t=>{
      const missingBot = startCount[t]-have[botColor][t];
      for(let i=0;i<missingBot;i++){ youCaptured.push(t); yourPts+=POINTS[t]; }
      const missingHuman = startCount[t]-have[humanColor][t];
      for(let i=0;i<missingHuman;i++){ botCaptured.push(t); botPts+=POINTS[t]; }
    });
    function miniIcon(type){ return '<svg viewBox="0 0 45 45"><use href="#pc-'+type+'"></use></svg>'; }
    capBottom.innerHTML = youCaptured.map(miniIcon).join('');
    capTop.innerHTML = botCaptured.map(miniIcon).join('');
    const diff = yourPts - botPts;
    advBottom.textContent = diff>0 ? ('+'+diff) : '';
    advTop.textContent = diff<0 ? ('+'+(-diff)) : '';
  }

  function renderHistory(){
    historyList.innerHTML = '';
    moveLog.forEach(row=>{
      const div = document.createElement('div'); div.className='hrow';
      const num = document.createElement('div'); num.className='hnum'; num.textContent=row.num+'.';
      const wCell = document.createElement('div'); wCell.className='hmove';
      const bCell = document.createElement('div'); bCell.className='hmove';
      function fill(cell, entry){
        if(!entry){ cell.textContent=''; return; }
        const san = document.createElement('span'); san.textContent = entry.san;
        cell.appendChild(san);
        if(entry.tag && entry.tag.tier!=='book' && entry.tag.tier!=='good'){
          const tg = document.createElement('span'); tg.className='htag '+TIER_CLASS[entry.tag.tier]; tg.textContent=entry.tag.chip;
          cell.appendChild(tg);
        }
      }
      fill(wCell, row.white); fill(bCell, row.black);
      div.appendChild(num); div.appendChild(wCell); div.appendChild(bCell);
      historyList.appendChild(div);
    });
    historyList.scrollTop = historyList.scrollHeight;
  }
  function logMove(color, san, tag){
    let entry;
    if(color==='w'){ entry = {san,tag}; moveLog.push({num: moveLog.length+1, white:entry, black:null}); }
    else { if(moveLog.length===0) moveLog.push({num:1, white:null, black:null}); entry = {san,tag}; moveLog[moveLog.length-1].black = entry; }
    renderHistory();
    return entry;
  }

  // ---------- suggestion / hint mode (asks the server) ----------
  function updateSuggestion(){
    clearSuggestion();
    playHintBtn.style.display = 'none';
    if(!hintMode || botThinking || gameOverFlag || game.turn()!==humanColor){
      lastSuggestionMove = null;
      hintText.classList.remove('active');
      hintText.textContent = hintMode ? 'Menunggu giliranmu…' : 'Nyalakan untuk dapat saran langkah terbaik tiap giliran kamu.';
      return;
    }
    hintText.classList.remove('active');
    hintText.textContent = 'Menghitung saran di server…';
    const fen = game.fen();
    api('/api/hint', { fen }).then(data=>{
      if(!hintMode || game.turn()!==humanColor || gameOverFlag || game.fen()!==fen) return;
      const m = data.move;
      lastSuggestionMove = m;
      const fromEl = getEl(m.from), toEl = getEl(m.to);
      if(fromEl) fromEl.classList.add('suggest-from');
      if(toEl) toEl.classList.add('suggest-to');
      hintText.classList.add('active');
      hintText.textContent = data.text;
      playHintBtn.style.display = 'block';
    }).catch(()=>{ hintText.textContent = 'Server lagi sibuk, coba lagi sebentar.'; });
  }
  playHintBtn.addEventListener('click', ()=>{
    if(!lastSuggestionMove || botThinking || gameOverFlag || game.turn()!==humanColor) return;
    ensureAudio();
    const m = lastSuggestionMove;
    const target = game.moves({square:m.from, verbose:true}).find(t=>t.to===m.to && (m.promotion?t.promotion===m.promotion:true));
    if(target) doPlayerMove(target);
  });

  // ---------- interaction ----------
  function onSquareClick(sq){
    if(botThinking || gameOverFlag) return;
    if(game.turn()!==humanColor) return;
    if(selected){
      const target = legalTargets.find(m=>m.to===sq);
      if(target){ doPlayerMove(target); return; }
    }
    const piece = game.get(sq);
    if(piece && piece.color===humanColor){
      clearHighlights();
      selected = sq;
      legalTargets = game.moves({square:sq, verbose:true});
      paintSelection();
    } else { clearHighlights(); selected=null; legalTargets=[]; }
  }

  function pushHistorySnapshot(){
    history.push({fen:game.fen(), pieceState:JSON.parse(JSON.stringify(pieceState)), moveLog:JSON.parse(JSON.stringify(moveLog))});
  }

  function doPlayerMove(target){
    const fenBefore = game.fen();
    pushHistorySnapshot();
    const m = game.move({from:target.from, to:target.to, promotion:'q'});
    clearHighlights(); clearSuggestion();
    selected=null; legalTargets=[];
    applyMoveToPieces(m);
    paintLastMove(m);
    renderCaptures();
    const entry = logMove(humanColor, m.san, {tier:'good', label:'', chip:''});
    updateStatus();
    paintCheck();
    if(game.in_check() && !gameOverFlag) sndCheck();

    const sanHistory = game.history();
    // classify in the background — never blocks the move itself
    api('/api/classify', { fenBefore, move:{from:m.from,to:m.to,promotion:m.promotion||null}, sanHistory }).then(data=>{
      entry.tag = data.tag;
      renderHistory();
      showBadge(m.to, TIER_CLASS[data.tag.tier], data.tag.chip);
      if(data.opening) updateOpeningDisplay(data.opening);
    }).catch(()=>{});

    if(!gameOverFlag){
      botThinking = true;
      hintText.textContent = ''; hintText.classList.remove('active');
      statusPill.textContent = currentName(botColor) + ' sedang berpikir…';
      runBotMove();
    }
  }

  function runBotMove(){
    const elo = parseInt(eloSlider.value,10);
    const fen = game.fen();
    const sanHistory = game.history();
    api('/api/bot-move', { fen, sanHistory, elo }).then(data=>{
      const mv = data.move;
      const m = game.move({from:mv.from, to:mv.to, promotion:mv.promotion||'q'});
      applyMoveToPieces(m);
      paintLastMove(m);
      renderCaptures();
      logMove(botColor, m.san, data.tag);
      showBadge(m.to, TIER_CLASS[data.tag.tier], data.tag.chip);
      if(data.opening) updateOpeningDisplay(data.opening);
      updateStatus();
      paintCheck();
      if(game.in_check() && !gameOverFlag) sndCheck();
      botThinking = false;
      updateSuggestion();
    }).catch((err)=>{
      console.error(err);
      statusPill.textContent = 'Server error — coba Undo atau Game Baru.';
      botThinking = false;
    });
  }

  // ---------- flip ----------
  function toggleFlip(){
    flipped = !flipped;
    refreshOrientation();
    pieceState.forEach(p=>{ const el = pieceEls.get(p.id); if(el) positionPieceEl(el, p.square); });
    clearHighlights(); clearSuggestion();
    paintLastMove(lastMoveObj);
    paintCheck();
    if(selected) paintSelection();
    if(hintMode && lastSuggestionMove){
      const fromEl = getEl(lastSuggestionMove.from), toEl = getEl(lastSuggestionMove.to);
      if(fromEl) fromEl.classList.add('suggest-from');
      if(toEl) toEl.classList.add('suggest-to');
    }
  }
  document.getElementById('flipBtn').addEventListener('click', ()=>{ ensureAudio(); toggleFlip(); });

  // ---------- controls ----------
  function updateEloUI(){
    const elo = parseInt(eloSlider.value,10);
    eloVal.textContent = elo;
    eloTag.textContent = eloTagText(elo);
    subTop.textContent = 'Elo ' + elo;
    savePref('elo', String(elo));
  }
  eloSlider.addEventListener('input', updateEloUI);

  playerNameInput.addEventListener('input', ()=>{ nameBottom.textContent = playerNameInput.value.trim()||'Kamu'; savePref('playerName', playerNameInput.value); updateStatus(); });
  botNameInput.addEventListener('input', ()=>{ nameTop.textContent = botNameInput.value.trim()||'Bot'; savePref('botName', botNameInput.value); updateStatus(); });
  sideSelect.addEventListener('change', ()=>{ savePref('side', sideSelect.value); startNewGame(); });
  hintToggle.addEventListener('change', ()=>{ hintMode = hintToggle.checked; savePref('hint', hintMode?'1':'0'); updateSuggestion(); });

  document.getElementById('newGameBtn').addEventListener('click', ()=>{ ensureAudio(); startNewGame(); });
  document.getElementById('modalNewGame').addEventListener('click', ()=>{ modalOverlay.classList.remove('show'); startNewGame(); });
  document.getElementById('modalClose').addEventListener('click', ()=>{ modalOverlay.classList.remove('show'); });
  document.getElementById('undoBtn').addEventListener('click', ()=>{
    if(botThinking) return;
    if(history.length===0) return;
    const snap = history.pop();
    game.load(snap.fen);
    pieceState = snap.pieceState;
    moveLog = snap.moveLog;
    gameOverFlag = false;
    modalOverlay.classList.remove('show');
    clearHighlights(); clearSuggestion(); selected=null; legalTargets=[];
    renderAllPieces();
    renderCaptures();
    renderHistory();
    updateStatus();
    paintCheck();
    updateSuggestion();
  });

  function updateAvatars(){
    avatarBottom.className = 'avatar ' + humanColor;
    avatarTop.className = 'avatar ' + botColor;
  }

  function startNewGame(){
    modalOverlay.classList.remove('show');
    humanColor = sideSelect.value;
    botColor = humanColor==='w' ? 'b' : 'w';
    flipped = humanColor==='b';
    game.reset();
    moveLog=[]; history=[]; selected=null; legalTargets=[]; gameOverFlag=false; botThinking=false;
    lastMoveObj=null; lastSuggestionMove=null; currentOpening=null;
    openingPill.style.display='none';
    openingDesc.textContent = 'Belum ada pembukaan terdeteksi — mulai jalan!';
    openingDesc.classList.add('active');
    initPieceState();
    refreshOrientation();
    renderAllPieces();
    clearHighlights(); clearSuggestion();
    renderCaptures();
    renderHistory();
    updateAvatars();
    updateStatus();
    badgeLayer.innerHTML = '';
    updateSuggestion();
    if(game.turn()===botColor){
      botThinking = true;
      statusPill.textContent = currentName(botColor) + ' sedang berpikir…';
      runBotMove();
    }
  }

  // ---------- openings library ----------
  let libDebounce = null;
  function renderLib(data){
    libSub.textContent = data.count + ' dari ' + data.total + ' pembukaan';
    libList.innerHTML = '';
    data.openings.forEach(o=>{
      const item = document.createElement('div');
      item.className = 'lib-item';
      item.innerHTML = '<span class="lib-item-name">'+o.name+'</span><span class="lib-item-eco">'+o.eco+'</span>'+
        '<div class="lib-item-moves">'+o.moves.join(' ')+'</div>'+
        (o.counter ? '<div class="lib-item-counter">'+o.counter+'</div>' : '');
      libList.appendChild(item);
    });
  }
  document.getElementById('libOpenBtn').addEventListener('click', ()=>{
    libOverlay.classList.add('show');
    apiGet('/api/openings').then(renderLib).catch(()=>{ libSub.textContent = 'Gagal memuat buku pembukaan.'; });
  });
  document.getElementById('libClose').addEventListener('click', ()=>libOverlay.classList.remove('show'));
  libSearch.addEventListener('input', ()=>{
    clearTimeout(libDebounce);
    libDebounce = setTimeout(()=>{
      apiGet('/api/openings?q='+encodeURIComponent(libSearch.value)).then(renderLib).catch(()=>{});
    }, 200);
  });

  // ---------- init ----------
  playerNameInput.value = loadPref('playerName','');
  botNameInput.value = loadPref('botName','');
  eloSlider.value = loadPref('elo','1200');
  sideSelect.value = loadPref('side','w');
  hintMode = loadPref('hint','0')==='1';
  hintToggle.checked = hintMode;
  nameBottom.textContent = playerNameInput.value.trim() || 'Kamu';
  nameTop.textContent = botNameInput.value.trim() || 'Bot';
  updateEloUI();
  startNewGame();
})();
