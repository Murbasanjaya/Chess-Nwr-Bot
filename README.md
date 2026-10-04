# Catur Kayu — Node.js Edition

Web catur **full Node.js/Express**. Semua perhitungan AI jalan di **server**,
bukan di browser — jadi HP/device kamu cuma perlu render papan, nggak perlu
mikir berat sama sekali.

Bukan pakai Stockfish atau engine pihak ketiga — **otak AI-nya buatan sendiri,
ditulis dari nol** di folder `engine/`. `chess.js` cuma dipakai di batas API
(validasi langkah & penulisan notasi SAN), nggak pernah ikut masuk ke dalam
loop pencarian.

## Seberapa cepat & seberapa pintar?

Engine-nya punya papan sendiri (representasi 0x88 + daftar bidak + Zobrist
hashing incremental), jadi dia nggak perlu bikin objek baru atau string FEN tiap
node seperti sebelumnya. Hasil ukuran di mesin pengembangan:

| Posisi | Jatah 100ms | 300ms | 1 detik | 3 detik |
|---|---|---|---|---|
| Posisi awal | 6 langkah | 9 | **12** | 14 |
| Posisi ramai (kiwipete) | 6 | 8 | **10** | 12 |
| Tengah permainan | 7 | 9 | **11** | 12 |
| Endgame pion | 11 | 13 | **18** | 20 |

Angka mentahnya: **~300.000 node/detik** di tengah permainan (sampai ~600.000
di endgame), generator langkah ~6 juta langkah/detik, evaluasi ~870.000
posisi/detik.

Sebagai pembanding, versi engine sebelumnya (yang pakai `chess.js` di dalam
loop search) butuh **37,6 detik** buat menembus 6 langkah ke depan di posisi
awal. Sekarang 6 langkah itu kelar di bawah 100ms, dan dalam 1 detik engine-nya
sampai 12 langkah.

Dan bukan cuma soal angka — dua engine-nya dipertandingkan langsung, 8 partai,
gantian main putih/hitam, dengan **engine lama dikasih waktu 10x lebih banyak
per langkah** (2138ms vs 206ms):

```
engine BARU: 6 menang, 2 seri, 0 kalah   (semua kemenangan lewat skakmat)
```

## Fitur

- **Engine catur buatan sendiri**, tiga lapis:
  - `engine/position.js` — papan 0x88, daftar bidak, Zobrist hashing
    incremental, make/unmake, generator langkah, deteksi serangan, SEE
  - `engine/evaluate.js` — evaluasi posisi
  - `engine/search.js` — pencarian langkah
- **Evaluasi tapered**: tiap bidak punya dua tabel (midgame & endgame) yang
  dicampur sesuai sisa materi — raja tahu harus sembunyi di awal dan maju ke
  tengah di endgame. Plus struktur pion lengkap (dobel, yatim, terbelakang,
  pion lolos dengan nilai per baris + jarak raja, pion bersambung), mobilitas
  tiap bidak, keamanan raja (tameng pion + bobot serangan ke zona raja),
  benteng di file terbuka & baris ke-7, kuda di outpost, pasangan gajah, tempo,
  dan penyesuaian endgame (termasuk dorongan menggiring raja musuh ke pojok
  biar skakmat dasar beneran kelar).
- **Pencarian modern**: negamax fail-soft + alpha-beta, iterative deepening,
  aspiration window, PVS, transposition table (persisten antar langkah),
  null-move pruning, Late Move Reductions, late move pruning, futility &
  reverse futility, razoring, SEE pruning, mate-distance pruning, check
  extension, internal iterative reduction, killer moves, counter-move, history
  heuristic, MVV-LVA, dan quiescence search dengan SEE + delta pruning.
- **Sadar seri**: riwayat posisi partai ikut dikirim ke engine, jadi dia tahu
  langkah mana yang bakal mengulang posisi — menghindari seri waktu posisinya
  menang, dan mengejar seri waktu kalah.
- Level 400–5000: makin tinggi makin dalam hitungannya, dan langsung eksekusi
  begitu nemu jalur skakmat paksa.
- **Mode Saran + tombol "Mainkan Saran Ini"** — sekarang saranya ikut bawa
  jalur lanjutan (principal variation) dan taksiran skor.
- Buku pembukaan **154 variasi** (kode ECO sesuai standar Encyclopaedia of
  Chess Openings — nama, urutan langkah, dan catatan counter singkat), bisa
  dijelajahi langsung dari UI ("Jelajahi 150+ Pembukaan"). Bot mainin buku di
  ~14 langkah pertama, baru mikir sendiri setelah itu.
- Badge kualitas langkah (💎 Brilian, ⭐ Hebat, ?! Kurang Tepat, ?? Blunder,
  dst) dinilai lewat **dua pencarian di kedalaman yang sama** — posisi sebelum
  dan sesudah langkah — jadi angka "ruginya" beneran berarti. Badge-nya pakai
  kedalaman tetap (bukan jatah waktu tetap) biar langkah yang sama selalu dapat
  badge yang sama (selama servernya nggak sampai kena batas waktu darurat).
- Poin bidak, animasi, efek suara, papan bisa diputar, pilih main sebagai
  Putih/Hitam, custom nama pemain & bot.

### Soal angka Elo

Angka 400–5000 di UI itu **tingkat kesulitan relatif**, bukan Elo hasil
pengukuran resmi lawan engine berperingkat. Yang dijamin: level yang lebih
tinggi memang mengalahkan level yang lebih rendah (`npm run test:match`
memverifikasi ini tiap kali dijalankan).

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

## Uji & benchmark

```bash
npm test              # perft + uji kebenaran (wajib lulus sebelum commit)
npm run bench         # kecepatan: node/detik, kedalaman per jatah waktu
npm run test:match    # level tinggi vs level rendah (bukti level itu nyata)
```

`npm test` menjalankan dua hal:

- **`test/perft.js`** — menghitung jumlah node persis di 7 posisi standar
  (startpos, kiwipete, posisi en-passant, promosi, dll) sampai kedalaman 5.
  Jumlahnya sudah diketahui luas, jadi kalau ada satu angka saja yang beda,
  berarti generator langkahnya bug (castling, en passant, promosi, pin). Total
  ~17 juta node, semuanya harus cocok.
- **`test/sanity.js`** — lima uji kebenaran:
  1. *Evaluasi simetris* — posisi yang dicerminkan harus bernilai persis minus
     nilai aslinya (menangkap bug warna/sisi).
  2. *Oracle skakmat* — pencarian buta exhaustive tanpa pemangkasan apa pun
     dipakai sebagai pembanding independen; engine harus setuju soal ada atau
     tidaknya skakmat paksa **dan** jumlah langkahnya.
  3. *Legalitas* — semua langkah yang dikeluarkan engine harus legal dan
     lengkap menurut chess.js, diuji di ratusan posisi dari partai acak.
  4. *Kualitas penilaian* — peringkat langkah dibandingkan dengan pencarian
     terpisah per langkah, plus uji determinisme.
  5. *Kesadaran seri* — K+B vs K dinilai seri, raja sendirian vs menteri
     dinilai kalah.

## Struktur project

```
catur-kayu-node/
├── server.js              # Express server + semua route API
├── engine/
│   ├── position.js        # papan 0x88, movegen, Zobrist, make/unmake, SEE
│   ├── evaluate.js        # evaluasi posisi (tapered: midgame + endgame)
│   ├── search.js          # negamax + alpha-beta + semua teknik pemangkasan
│   └── chessEngine.js     # "muka" engine: level Elo, buku, klasifikasi langkah
├── data/
│   └── openings.js        # 154 pembukaan (ECO, nama, langkah, counter)
├── public/
│   ├── index.html         # UI (papan, panel samping, modal)
│   └── app.js             # Logika client: render, animasi, suara, fetch ke API
├── test/
│   ├── perft.js           # verifikasi generator langkah
│   ├── sanity.js          # uji kebenaran engine
│   ├── match.js           # level tinggi vs level rendah
│   └── bench.js           # benchmark kecepatan
└── package.json
```

## API yang dipakai frontend

- `POST /api/bot-move` `{fen, sanHistory, elo}` → langkah bot berikutnya
  (dari buku atau hasil pencarian), plus tag kualitas, nama pembukaan, dan
  `info` (kedalaman, jumlah node, node/detik, skor, skakmat dalam N)
- `POST /api/classify` `{fenBefore, move, sanHistory}` → grading langkah yang
  baru dijalankan pemain, plus `loss` (centipawn yang hilang) & langkah terbaik
- `POST /api/hint` `{fen, sanHistory}` → saran langkah terbaik + jalur lanjutan
  (PV) + taksiran skor
- `POST /api/analyze` `{fen, sanHistory, depth, ms}` → analisis posisi: skor,
  kedalaman, jalur utama, evaluasi statis
- `GET /api/openings?q=...` → daftar/cari pembukaan dari buku

## Setelan lewat environment variable

- `PORT` — port server (default 3000)
- `CATUR_TT_MB` — ukuran tabel transposisi dalam MB (default ~19MB, sekitar
  1 juta entry). Tabel lebih besar = engine lebih pintar di pencarian panjang;
  kecilkan kalau jalan di device dengan RAM terbatas.

## Deploy (opsional)

Karena ini Express biasa (bukan serverless function), paling gampang deploy ke
layanan yang support long-running Node process kayak **Railway**, **Render**,
atau VPS. Kalau mau ke **Vercel** (yang biasa kamu pakai), API route-nya perlu
dibungkus jadi serverless function (folder `api/` bergaya Vercel) — kalau mau,
bilang aja, aku bisa bantu adaptasi strukturnya.

Satu catatan buat serverless: tabel transposisi engine ini sengaja dibikin
persisten antar langkah (itu salah satu sumber kecepatannya). Di serverless
yang prosesnya mati tiap request, keuntungan itu hilang, jadi engine-nya bakal
terasa agak lebih lambat walau tetap jauh di atas versi lama.

## Catatan teknis

- `chess.js` versi `0.10.3` dipin sengaja (API lama gaya `in_checkmate()`,
  `game.moves({verbose:true})`, dst). Jangan asal `npm update` ke versi 1.x,
  karena nama fungsinya beda (versi baru pakai `isCheckmate()` dst) dan bakal
  bikin error. Engine intinya nggak tergantung chess.js, tapi `server.js` dan
  lapisan terjemahan langkah masih pakai.
- Engine-nya **single-thread**. Node punya `worker_threads` dan secara teori
  bisa dipakai buat pencarian paralel (Lazy SMP), tapi itu belum dikerjakan —
  jadi kecepatan di atas adalah kecepatan satu inti.
- Pencarian jalan **sinkron** dan nggak pakai `await` di tengah jalan, jadi dua
  request nggak akan saling tumpang tindih di tengah pencarian. Konsekuensinya:
  satu request berat memang menahan request lain sampai selesai. Buat satu-dua
  pemain ini aman; kalau mau dipakai rame-rame, pindahkan pencarian ke worker
  thread.
- Skor evaluasi dalam **centipawn** (100 = satu pion) dari sudut pandang pihak
  yang jalan. Skor di atas ~30.000 artinya skakmat paksa sudah ketemu.
