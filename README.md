# Catur Kayu — Node.js Edition

Web catur **full Node.js/Express**. Semua perhitungan AI (minimax + alpha-beta +
quiescence search + evaluasi posisional) jalan di **server**, bukan di browser —
jadi HP/device kamu cuma perlu render papan, nggak perlu mikir berat sama sekali.

Bukan pakai Stockfish atau engine pihak ketiga — otak AI-nya buatan sendiri,
ditulis dari nol di `engine/chessEngine.js`.

## Fitur

- AI buatan sendiri: minimax + alpha-beta pruning + quiescence search (nggak
  salah baca posisi pas ada tukar bidak, termasuk pas lagi diskak), evaluasi
  materi + piece-square table + struktur pion (dobel/yatim/**pion lolos**) +
  pasangan gajah
- **Transposition table**, **killer moves**, **history heuristic**, dan
  **MVV-LVA move ordering** buat pruning yang jauh lebih efisien — AI bisa
  mikir jauh lebih dalam di waktu yang sama
- **Check extension** — kalau lagi diskak, AI cari lebih dalam lagi biar nggak
  kelewat rangkaian skak/paksaan (dibatasi biar tetap aman & cepat)
- Elo 400–5000 (makin tinggi, makin dalam AI menghitung — sampai 10 langkah ke
  depan di Elo maksimal, dan langsung eksekusi kalau nemu jalur skakmat paksa)
- Buku pembukaan **154 variasi** (ECO code + nama + catatan counter singkat),
  bisa dijelajahi langsung dari UI ("Jelajahi 150+ Pembukaan")
- Bot otomatis mainin buku pembukaan di ~14 langkah pertama, baru mikir sendiri
  setelah itu
- Badge kualitas langkah (💎 Brilian, ⭐ Hebat, ?! Kurang Tepat, ?? Blunder, dst)
- Mode Saran (hint) — AI kasih tau langkah terbaik buat giliran kamu
- Poin bidak, animasi, efek suara, papan bisa diputar, pilih main sebagai
  Putih/Hitam, custom nama pemain & bot

## Cara jalanin (di Termux / laptop / server manapun)

```bash
# 1. masuk ke folder project
cd catur-kayu-node

# 2. install dependency (butuh koneksi internet buat sekali ini aja)
npm install

# 3. jalanin server
npm start
```

Setelah itu buka `http://localhost:3000` di browser (di Termux, buka browser
HP kamu sendiri ke alamat itu — kalau mau akses dari device lain di jaringan
yang sama, cek IP lokal HP kamu dengan `ifconfig` atau `ip a`, lalu buka
`http://<ip-hp-kamu>:3000` dari device lain).

## Struktur project

```
catur-kayu-node/
├── server.js              # Express server + semua route API
├── engine/
│   └── chessEngine.js     # AI: search, evaluasi, buku pembukaan, klasifikasi langkah
├── data/
│   └── openings.js        # 154 pembukaan (ECO, nama, langkah, counter)
├── public/
│   ├── index.html         # UI (papan, panel samping, modal)
│   └── app.js              # Logika client: render, animasi, suara, fetch ke API
└── package.json
```

## API yang dipakai frontend

- `POST /api/bot-move` `{fen, sanHistory, elo}` → langkah bot berikutnya
  (dari buku atau hasil pencarian), plus tag kualitas & nama pembukaan
- `POST /api/classify` `{fenBefore, move, sanHistory}` → grading langkah yang
  baru dijalankan pemain
- `POST /api/hint` `{fen}` → saran langkah terbaik buat mode Saran
- `GET /api/openings?q=...` → daftar/cari pembukaan dari buku

## Deploy (opsional)

Karena ini Express biasa (bukan serverless function), paling gampang deploy ke
layanan yang support long-running Node process kayak **Railway**, **Render**,
atau VPS. Kalau mau ke **Vercel** (yang biasa kamu pakai), API route-nya perlu
dibungkus jadi serverless function (folder `api/` bergaya Vercel) — kalau mau,
bilang aja, aku bisa bantu adaptasi strukturnya.

## Catatan

- `chess.js` versi `0.10.3` dipin sengaja (API lama gaya `in_checkmate()`,
  `game.moves({verbose:true})`, dst) — biar konsisten sama kode engine-nya.
  Jangan asal `npm update` ke versi 1.x, karena nama fungsinya beda (versi baru
  pakai `isCheckmate()` dst) dan bakal bikin error.
- Semua eval/AI ada di satu file (`engine/chessEngine.js`) biar gampang kamu
  oprek/tambahin sendiri kalau mau eksperimen.
