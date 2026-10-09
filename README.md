# Catur Kayu — Node.js Edition

Web catur **full Node.js/Express**. Semua perhitungan AI jalan di **server**,
bukan di browser — jadi HP/device kamu cuma perlu render papan, nggak perlu
mikir berat sama sekali.

**Otak AI-nya buatan sendiri, ditulis dari nol** di folder `engine/`. Aplikasi
ini nggak memakai Stockfish atau engine pihak ketiga waktu main. `chess.js`
cuma dipakai di batas API (validasi langkah & notasi SAN), nggak pernah ikut
masuk ke dalam loop pencarian.

Stockfish memang dipakai, tapi **cuma sebagai alat ukur di folder `test/tools/`**
(devDependency): jadi "penggaris" buat mengukur Elo, dan jadi "guru" waktu
bobot evaluasi di-tuning. Lihat [Alat ukur & tuning](#alat-ukur--tuning).

## Seberapa kuat? (diukur, bukan ditebak)

Semua angka di bawah berasal dari pertandingan sungguhan melawan Stockfish 19
yang dibatasi kekuatannya lewat opsi resmi `UCI_Elo`.

| | |
|---|---|
| **Level maksimal** (500.000 node/langkah, ~1 detik) | **~2713 Elo** (95%: 2642–2785, dari 120 partai) |
| Rentang level yang tersedia di slider | 350 – 2700 |
| Skala | UCI_Elo Stockfish 19 (skala yang dikalibrasi tim Stockfish ke daftar CCRL) — BUKAN rating FIDE/chess.com/lichess |
| Diukur | 2026-10-09 |

**Soal "setara Stockfish":** belum, dan jujur saja nggak akan dengan engine
JavaScript buatan sendiri. Skala `UCI_Elo` cuma sampai 3190 — Stockfish versi
penuh jauh di atas itu (di daftar CCRL sekitar 3600+). Selisihnya datang dari
jaringan saraf (NNUE) Stockfish, kode C++ multi-thread yang puluhan kali lebih
cepat, dan belasan tahun tuning oleh ribuan kontributor.

### Skalanya apa?

Angka Elo di sini memakai skala `UCI_Elo` Stockfish, yang menurut tim
Stockfish dikalibrasi kira-kira ke daftar **CCRL Blitz** (daftar rating antar
engine). **Ini bukan rating FIDE, chess.com, atau lichess.** Skala engine dan
skala manusia nggak bisa disamakan begitu saja — terutama di level bawah.
Pakai angkanya sebagai ukuran kekuatan relatif yang konsisten, bukan sebagai
"setara pemain manusia ber-rating X".

### Riwayat peningkatan (A/B test)

Tiap perubahan dibuktikan lewat pertandingan engine-baru vs engine-lama
dengan jatah sama (30.000 node per langkah, 300 partai, pembuka seimbang,
warna ditukar). Rentang di kurung = selang kepercayaan 95%.

| Perubahan | Hasil |
|---|---|
| Bobot evaluasi di-tuning (36rb posisi, label Stockfish) | **+54 Elo** (+27 … +81) |
| Tuning putaran 2 (212rb posisi) | **+23 Elo** (−3 … +49) — arahnya positif, belum signifikan penuh |
| Search baru: continuation history, singular extension, LMR berbasis history, cache evaluasi, manajemen waktu | **+80 Elo** (+55 … +106) |
| Perbaikan bug pemilihan langkah di level berderau (ketahuan saat kalibrasi, lihat di bawah) | level menengah s=0.85: **~2000 → 2586** |

**Sebelum vs sesudah, kondisi sama persis** (300ms per langkah, lawan
Stockfish ber-`UCI_Elo`, 60 partai):

| Versi | Hasil | Elo |
|---|---|---|
| Engine di awal pekerjaan ini | 75% vs Stockfish 2000 | ~2191 (2092–2330) |
| Engine sekarang | 56,7% vs Stockfish 2500 | **~2547** (2475–2622) |

Jadi sekitar **+350 Elo** pada jatah waktu yang sama.

**Bug yang ketahuan berkat kalibrasi:** waktu pertama diukur, level s=0.85
cuma menang 5% melawan Stockfish 2510 — mustahil kalau bedanya dengan level
penuh (~2713) cuma jatah node 3× lebih kecil. Penyebabnya: kalau penilaian
langkah-langkah alternatif kehabisan jatah, langkah yang belum sempat dinilai
masih membawa angka perkiraan dari pencarian utama yang sering nyaris sama
dengan langkah terbaik, lalu ikut "diundi" oleh derau dan terpilih. Sekarang
tiap langkah punya tanda `exact`, langkah yang belum dinilai nggak pernah
diundi, dan ada uji regresinya di `test/sanity.js`.

### Kecepatan

Hasil `npm run bench` di mesin pengembangan (satu inti):

- ~300.000–350.000 node/detik di tengah permainan, ~650.000 di endgame
- generator langkah ~6 juta langkah/detik, evaluasi ~870.000 posisi/detik
- level maksimal (500.000 node) biasanya jalan dalam **~1 detik**; langkah
  yang "jelas" (langkah terbaik stabil beberapa iterasi) diputuskan lebih
  cepat lagi, langkah paksa langsung

## Level Elo

Kekuatan bot diatur lewat **satu angka kontinu** `s` (0 = paling lemah,
1 = penuh) yang menentukan tiga hal:

- **batas node** per langkah (level berderau boleh memakai jatah yang sama
  sekali lagi untuk menilai langkah-langkah alternatif) — sengaja node, *bukan* waktu: dengan batas waktu,
  bot di HP lambat jadi jauh lebih lemah daripada di server kencang, dan angka
  Elo apa pun jadi nggak bermakna. Dengan node, kekuatannya sama di semua
  perangkat; yang beda cuma lama mikirnya.
- **derau** pemilihan langkah (centipawn) — langkah yang selisihnya dengan
  langkah terbaik masih di dalam derau ini bisa terpilih
- **peluang blunder** — kesalahan "manusiawi" (rugi 1–5 pion), bukan langkah
  terburuk di papan

Hubungan `s` ↔ Elo diukur oleh `npm run elo:calibrate` dan disimpan di
`engine/elo-calibration.json`. Slider di UI otomatis memakai rentang yang
terukur (`GET /api/levels`), dan angka di antara titik ukur diinterpolasi.

| s | Batas node | Derau | Blunder | Elo terukur | Rentang 95% | Partai | Lawan |
|---|---|---|---|---|---|---|---|
| 1.00 | 500.000 | 0 cp | 0.0% | **2713** | 2642–2785 | 120 | Stockfish UCI_Elo 2200 (50M 8S 2K); Stockfish UCI_Elo 2580 (34M 20S 6K) |
| 0.85 | 148.094 | 2 cp | 0.0% | **2586** | 2515–2658 | 60 | Stockfish UCI_Elo 2510 (26M 21S 13K) |
| 0.70 | 43.864 | 23 cp | 0.0% | **2454** | 2385–2524 | 60 | Stockfish UCI_Elo 2390 (24M 23S 13K) |
| 0.55 | 12.992 | 60 cp | 0.0% | **2262** | 2181–2342 | 60 | Stockfish UCI_Elo 2250 (26M 10S 24K) |
| 0.40 | 3.848 | 110 cp | 2.2% | **1926** | 1844–2009 | 60 | Stockfish UCI_Elo 2060 (13M 12S 35K) |
| 0.25 | 1.140 | 173 cp | 8.8% | **1399** | 1319–1480 | 180 | Stockfish UCI_Elo 1730 (4M 4S 52K); engine s=0.4 (~1926) (4M 1S 55K); Stockfish UCI_Elo 1400 (28M 4S 28K) |
| 0.10 | 338 | 246 cp | 17.9% | **1223** | 1096–1351 | 60 | engine s=0.25 (~1399) (16M 0S 44K) |
| 0.00 | 150 | 300 cp | 25.0% | **963** | 797–1130 | 60 | engine s=0.1 (~1223) (9M 4S 47K) |
| -0.25 | 150 | 500 cp | 40.0% | **592** | 408–776 | 180 | engine s=0 (~963) (7M 3S 50K); engine s=0 (~963) (5M 3S 52K); engine s=0 (~963) (3M 2S 55K) |
| -0.50 | 150 | 700 cp | 55.0% | **337** | 138–537 | 120 | engine s=-0.25 (~592) (7M 3S 50K); engine s=-0.25 (~592) (13M 2S 45K) |

Titik di bawah 1320 (batas bawah `UCI_Elo` Stockfish) diukur melawan titik
engine ini sendiri yang sudah terkalibrasi (rantai Elo), jadi
ketidakpastiannya bertumpuk — makin bawah, makin kasar perkiraannya.

## Fitur

- **Engine catur buatan sendiri**, tiga lapis:
  - `engine/position.js` — papan 0x88, daftar bidak, Zobrist hashing
    incremental, make/unmake, generator langkah, deteksi serangan, SEE
  - `engine/evaluate.js` — evaluasi posisi (602 pasang parameter)
  - `engine/search.js` — pencarian langkah
- **Evaluasi tapered yang di-tuning**: materi, piece-square table, struktur
  pion (dobel, yatim, terbelakang, phalanx & pion dijaga per baris, pion lolos
  per baris + diblokir/jalan bebas + jarak raja), mobilitas per jumlah kotak,
  keamanan raja, **ancaman** (bidak diserang pion / bidak lebih murah, bidak
  menggantung), benteng di file terbuka & baris ke-7, outpost, pasangan gajah,
  tempo, dan penyesuaian endgame. Semua bobotnya hasil tuning metode Texel
  terhadap penilaian Stockfish di 212 ribu posisi (`engine/eval-params.json`).
- **Pencarian modern**: negamax fail-soft + alpha-beta, iterative deepening,
  aspiration window, PVS, transposition table persisten antar langkah,
  null-move pruning, Late Move Reductions (disesuaikan history), late move
  pruning, futility & reverse futility, razoring, history pruning, SEE
  pruning, mate-distance pruning, check extension, **singular extension**,
  internal iterative reduction, killer moves, counter-move, history &
  **continuation history** (update bergaya gravity), MVV-LVA, quiescence
  dengan SEE + delta pruning, cache evaluasi.
- **Manajemen waktu**: langkah yang sudah jelas diputuskan lebih cepat, waktu
  ditambah kalau skor baru anjlok.
- **Sadar seri**: riwayat posisi partai ikut dikirim ke engine, jadi dia tahu
  langkah mana yang bakal mengulang posisi.
- **Mode Saran + tombol "Mainkan Saran Ini"** — saran ikut bawa jalur
  lanjutan (principal variation) dan taksiran skor.
- Buku pembukaan **154 variasi** (kode ECO sesuai standar Encyclopaedia of
  Chess Openings), bisa dijelajahi dari UI. Bot mainin buku di ~14 langkah
  pertama, baru mikir sendiri setelah itu.
- Badge kualitas langkah (💎 Brilian, ⭐ Hebat, ?! Kurang Tepat, ?? Blunder,
  dst) dinilai lewat dua pencarian di kedalaman yang sama (sebelum & sesudah
  langkah), dengan kedalaman tetap supaya langkah yang sama selalu dapat badge
  yang sama.
- Poin bidak, animasi, efek suara, papan bisa diputar, pilih main sebagai
  Putih/Hitam, custom nama pemain & bot.

## Cara jalanin (di Termux / laptop / server manapun)

```bash
# 1. masuk ke folder project
cd catur-kayu-node

# 2. install dependency (butuh koneksi internet buat sekali ini aja)
npm install --omit=dev      # cukup buat MAIN; tanpa Stockfish (~200MB)
# npm install               # kalau mau ikut pakai alat ukur/tuning di test/tools

# 3. jalanin server
npm start
```

Setelah itu buka `http://localhost:3000` di browser (di Termux, buka browser
HP kamu sendiri ke alamat itu — kalau mau akses dari device lain di jaringan
yang sama, cek IP lokal HP kamu dengan `ifconfig` atau `ip a`, lalu buka
`http://<ip-hp-kamu>:3000` dari device lain).

## Uji & benchmark

```bash
npm test              # perft + uji kebenaran (wajib lulus sebelum commit)
npm run bench         # kecepatan: node/detik, waktu per level
npm run test:match    # level tinggi vs level rendah (bukti level itu nyata)
```

`npm test` menjalankan:

- **`test/perft.js`** — jumlah node persis di 7 posisi standar (startpos,
  kiwipete, en-passant, promosi, dll), total ~17 juta node. Satu angka beda =
  generator langkahnya bug.
- **`test/sanity.js`** — simetri evaluasi (posisi dicerminkan harus bernilai
  persis minus nilainya), oracle skakmat exhaustive sebagai pembanding
  independen, legalitas langkah di ratusan posisi acak, kualitas penilaian
  langkah, determinisme, kesadaran seri, dan konsistensi level Elo.

## Alat ukur & tuning

Butuh devDependency `stockfish` (`npm install` biasa). Stockfish dijalankan
sebagai **proses terpisah** lewat protokol UCI, cuma oleh skrip di
`test/tools/` — server dan engine nggak pernah memanggilnya.

```bash
# adu dua "pemain" secara paralel (semua core), hasilnya selisih Elo + rentang 95%
npm run elo:gauntlet -- --a '{"type":"ours","s":1}' --b '{"type":"sf","elo":2400}' --games 60

# kalibrasi ulang tabel Elo (lama: ~1-2 jam)
npm run elo:calibrate

# tuning bobot evaluasi
npm run tune:genpos -- 5000 posisi.txt          # posisi dari self-play
npm run tune:label  -- posisi.txt label.txt 9   # nilai tiap posisi oleh Stockfish depth 9
npm run tune:fit    -- label.txt 800 --write    # cocokkan bobot -> engine/eval-params.json
```

Kalau bobot evaluasi atau search diubah, **kalibrasi Elo harus diulang** —
tabelnya cuma berlaku buat engine yang diukur.

Pemain buat `elo:gauntlet`: `{"type":"ours","s":0.7}` (titik kekuatan),
`{"type":"ours","elo":1800}` (lewat tabel kalibrasi),
`{"type":"ours","nodes":30000,"dir":"/path/ke/engine-lain"}` (A/B test), atau
`{"type":"sf","elo":2000}`.

## Struktur project

```
catur-kayu-node/
├── server.js                 # Express server + semua route API
├── engine/
│   ├── position.js           # papan 0x88, movegen, Zobrist, make/unmake, SEE
│   ├── evaluate.js           # evaluasi posisi (tapered, parameter bisa di-tuning)
│   ├── eval-params.json      # bobot evaluasi hasil tuning
│   ├── search.js             # negamax + alpha-beta + semua teknik pemangkasan
│   ├── elo-calibration.json  # tabel s <-> Elo hasil pertandingan
│   └── chessEngine.js        # "muka" engine: level Elo, buku, klasifikasi langkah
├── data/
│   └── openings.js           # 154 pembukaan (ECO, nama, langkah, counter)
├── public/
│   ├── index.html            # UI (papan, panel samping, modal)
│   └── app.js                # logika client: render, animasi, suara, fetch ke API
├── test/
│   ├── perft.js, sanity.js, match.js, bench.js
│   └── tools/                # alat ukur & tuning (pakai Stockfish sebagai penggaris)
│       ├── gauntlet.js, worker.js, uci.js, openings.js
│       ├── calibrate.js + calibration-log.json (hasil mentah tiap pertandingan)
│       └── genpos.js, label.js, tune.js
└── package.json
```

## API yang dipakai frontend

- `POST /api/bot-move` `{fen, sanHistory, elo}` → langkah bot berikutnya
  (dari buku atau hasil pencarian), plus tag kualitas, nama pembukaan, dan
  `info` (kedalaman, node, node/detik, skor, skakmat dalam N, Elo terpakai)
- `POST /api/classify` `{fenBefore, move, sanHistory}` → grading langkah
  pemain, plus `loss` (centipawn yang hilang) & langkah terbaik
- `POST /api/hint` `{fen, sanHistory}` → saran langkah + jalur lanjutan + skor
- `POST /api/analyze` `{fen, sanHistory, depth, ms}` → analisis posisi
- `GET /api/levels` → rentang Elo terkalibrasi + label tiap rentang
- `GET /api/openings?q=...` → daftar/cari pembukaan dari buku

## Setelan lewat environment variable

- `PORT` — port server (default 3000)
- `CATUR_TT_MB` — ukuran tabel transposisi dalam MB (default ~19MB). Kecilkan
  kalau RAM terbatas.

## Deploy (opsional)

Karena ini Express biasa (bukan serverless function), paling gampang deploy ke
layanan yang support long-running Node process kayak **Railway**, **Render**,
atau VPS (`npm install --omit=dev`, lalu `npm start`). Kalau mau ke **Vercel**,
API route-nya perlu dibungkus jadi serverless function — bilang aja kalau mau
dibantu adaptasi.

Catatan buat serverless: tabel transposisi engine ini persisten antar langkah
(salah satu sumber kecepatannya). Di serverless yang prosesnya mati tiap
request, keuntungan itu hilang — kekuatan per level tetap sama (karena
dibatasi node), tapi mikirnya sedikit lebih lama.

## Catatan teknis & lisensi

- Proyek ini MIT. Paket `stockfish` (GPL-3.0) cuma devDependency yang dipanggil
  sebagai proses terpisah oleh alat ukur; dia nggak ikut terpasang dengan
  `npm install --omit=dev` dan nggak dipakai aplikasi.
- `chess.js` versi `0.10.3` dipin sengaja (API lama gaya `in_checkmate()`).
  Jangan asal `npm update` ke versi 1.x — nama fungsinya beda.
- Engine-nya **single-thread**. Pencarian paralel (Lazy SMP via
  `worker_threads`) belum dikerjakan.
- Pencarian jalan **sinkron**, jadi satu request berat menahan request lain
  sampai selesai. Buat satu-dua pemain aman; kalau mau dipakai rame-rame,
  pindahkan pencarian ke worker thread.
- Skor dalam **centipawn** (100 ≈ satu pion) dari sudut pandang pihak yang
  jalan. Skor di atas ~30.000 artinya skakmat paksa sudah ketemu.
- Angka "depth" bukan ukuran kekuatan yang bisa dibandingkan antar versi:
  versi sekarang mencapai depth nominal sedikit lebih kecil per detik
  dibanding versi sebelumnya (singular extension & reduksi yang lebih
  hati-hati bikin tiap depth lebih menyeluruh), tapi terbukti +80 Elo lebih
  kuat pada jatah node yang sama.
