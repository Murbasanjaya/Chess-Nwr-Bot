'use strict';
// Posisi pembuka seimbang buat pertandingan uji: diambil dari buku pembukaan
// proyek ini sendiri (data/openings.js). Tiap posisi dimainkan dua kali dengan
// warna ditukar, jadi keunggulan pembukaan saling meniadakan.
const { Chess } = require('chess.js');
const OPENINGS = require('../../data/openings.js');

function openingFens(minPly) {
  const seen = new Set(), out = [];
  for (const o of OPENINGS) {
    if (o.moves.length < (minPly || 4)) continue;
    const g = new Chess();
    let ok = true;
    for (const m of o.moves) { if (!g.move(m)) { ok = false; break; } }
    if (!ok) continue;
    const key = g.fen().split(' ').slice(0, 4).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: o.name, fen: g.fen(), moves: o.moves.slice() });
  }
  return out;
}
module.exports = { openingFens };
