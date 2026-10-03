# Blueprint TERAS Academy & SKTTK — Revisi untuk MVP, Path B, dan Pengembangan Lanjutan

**Status:** arah revisi disetujui pengguna; dokumen ini adalah acuan pengembangan, bukan persetujuan rilis, pengesahan konten regulasi, atau keputusan kompetensi peserta.

**Dasar:** blueprint ekspor Notion “Blueprint TERAS SKTTK — Evaluasi, Framework & Pipeline Agentic AI”, rekomendasi penelaahan yang disetujui pengguna, dan batas produk TERAS yang sudah ditetapkan.

**Cakupan pelaksanaan dokumen:** menyelaraskan blueprint. Tidak mengubah aplikasi, database, konfigurasi produksi, atau penugasan pekerjaan yang sedang berjalan.

## 1. Ringkasan keputusan

TERAS membangun kemampuan dan menyiapkan peserta beserta bukti untuk proses asesmen kompetensi resmi di luar platform. TERAS bukan lembaga penerbit sertifikasi resmi.

Perbaikan utama bukan memperbanyak chatbot atau mengganti stack, melainkan:

1. Menuntaskan perjalanan pengguna dan dashboard operasional seluruh peran.
2. Mempertahankan backend sebagai sumber kebenaran untuk identitas, ownership, penilaian, safety, readiness, dan histori.
3. Memisahkan pengembangan kemampuan dari persiapan sertifikasi melalui dua pathway.
4. Membuktikan kualitas agentic yang sudah ada sebelum memperluas kemampuan atau kanalnya.
5. Menyelesaikan review sumber, relasi, dan ketahanan katalog sebelum memakai konten SKTTK sebagai konten resmi.
6. Mengikat persetujuan rilis pada bukti kandidat yang dapat ditinjau, bukan pada build sukses atau tes lokal saja.

**Keputusan terhadap blueprint asal**

| Bagian | Keputusan | Penjelasan |
| --- | --- | --- |
| Pemisahan LLM dan keputusan deterministik | Pertahankan | AI tidak menetapkan keputusan readiness atau sertifikasi secara bebas |
| Safety non-kompensabel | Pertahankan | Kegagalan keselamatan kritis tidak ditutupi skor komposit |
| Paket pengetahuan bersumber dan berversi | Pertahankan dan perketat | Sumber per isi, review manusia, dan dampak versi harus terlacak |
| Bobot 30/25/25/20; ambang 70/80; usia enam bulan | Jangan adopsi sebagai aturan sah | Angka contoh belum memiliki dasar per skema atau validasi |
| Hermes, OpenClaw, MultiClaw | Kandidat eksperimen, bukan dependensi MVP | Kebutuhan, versi, lisensi, keamanan, dan manfaat harus dibuktikan |
| Armada banyak agent sekaligus | Tunda | Perluasan dilakukan bertahap setelah baseline operasional terverifikasi |
| CAT, voice, vision, kanal pesan | Pasca-MVP dengan gate tersendiri | Tidak boleh mengalihkan prioritas dari alur peran dan bukti produksi |
| Evaluasi hanya dari landing | Batasi kesimpulannya | “Tidak terlihat” bukan bukti bahwa fitur tidak tersedia |

## 2. Batas produk dan dua pathway

Learning Progress, Learning Achievement, Capability, Capability Readiness, dan Official Certification adalah konsep berbeda. Persentase penyelesaian materi tidak otomatis menjadi bukti kompetensi atau kesiapan.

| Dimensi | Path A — Capability Development | Path B — Pre-Certification |
| --- | --- | --- |
| Tujuan | Mengembangkan kemampuan untuk konteks kerja | Menyiapkan peserta dan bukti untuk proses asesmen eksternal |
| Dasar evaluasi | Outcome kemampuan dan praktik yang disetujui | Framework serta persyaratan persiapan yang telah direview |
| Bukti | Bukti pencapaian kemampuan | Bukti persiapan terhadap persyaratan skema |
| Hasil | Capability Achievement dan Capability Portfolio | Certification Readiness dan Certification Readiness Portfolio |
| KPI | Pencapaian, kualitas praktik, penutupan gap | Kelengkapan bukti, penutupan gap, kesiapan handoff |
| Batas klaim | Bukan sertifikat kompetensi resmi | Bukan keputusan kelulusan atau jaminan sertifikasi resmi |

Materi dapat dipakai bersama jika outcome cocok. State, evidence, assessment, readiness, histori, dan cache tetap terisolasi per peserta dan pathway. Penggunaan ulang materi harus melalui assignment eksplisit, bukan dengan menghapus pemeriksaan ownership.

Solar PV adalah domain implementasi; Installation atau Design adalah track/peran, bukan definisi Path A atau Path B.

## 3. Tiga kelompok cakupan pengembangan

### 3.1 MVP pertama: lengkap dan dapat dibuktikan

MVP tetap mencakup agentic yang sudah ditetapkan. Konten SKTTK resmi tetap di luar MVP pertama sampai prasyarat review terpenuhi.

| Area | Cakupan wajib | Bukti selesai |
| --- | --- | --- |
| Admin | People, role, program, pathway, enrollment, curriculum, governance, konfigurasi | Perubahan sah berhasil; akses tak berwenang ditolak; histori dapat ditinjau |
| Trainer | Authoring, materi terkelola, tugas, feedback, remediasi | Buat/edit/publish dan unggah/akses materi bekerja sesuai izin |
| Learner | Discover, learn/resume, practice, evidence, feedback, remediasi | Perjalanan sebab-akibat tersambung tanpa melompati transisi |
| Verifier/validator | Antrean bukti, pemeriksaan kualitas, koreksi, keputusan review | UI operasional dan histori review bertambah tanpa menimpa keputusan lama |
| Assessor/readiness reviewer | Evaluasi tahap persiapan dan reassessment | Evaluasi tersimpan sah dan tidak diklaim sebagai asesmen resmi eksternal |
| Stakeholder berwenang | Pemantauan kohort, intervensi, readiness, handoff | Cakupan akses sesuai penugasan dan minimisasi data |
| Storage | Materi trainer dan berkas bukti learner | Upload, pengaitan, akses sah, penolakan akses lintas pemilik, dan kebijakan retensi teruji |
| Agentic | Kemampuan yang sudah disetujui | Gate produksi, regresi struktural, review insiden, dan governance lulus |

Daftar di atas adalah kriteria produk, bukan pernyataan bahwa semua fitur belum tersedia. Temuan audit sebelumnya adalah snapshot; verifikasi ulang sebelum menjadikannya pekerjaan implementasi.

### 3.2 Fondasi Path B: dapat dikerjakan paralel secara terkendali

Urutan: framework kompetensi → integration review terhadap LMS dan diagnostic → review isi resmi serta relasinya → diagnostic berbasis framework yang disetujui → aturan readiness yang dapat dikonfigurasi.

Membuka pekerjaan fondasi Path B tidak berarti konten resmi boleh langsung dipublikasikan, dan tidak menggugurkan gate rilis MVP.

### 3.3 Pengembangan lanjutan

Tutor teknis generatif, simulasi wawancara, vision untuk bantuan review, CAT, WhatsApp/Telegram, dan multi-agent adalah perluasan yang membutuhkan persetujuan tersendiri. Baseline agentic terverifikasi merupakan prasyarat, tetapi tidak otomatis mengizinkan setiap kemampuan baru.

## 4. Perjalanan peserta dan kewenangan peran

**Perjalanan kanonis**

Diagnostic → Gap → Learning Plan → Learn → Practice → Evidence → Feedback → Remediation → Re-practice → Reassessment → Readiness → Capability Passport → proses kompetensi resmi eksternal jika relevan.

Urutan ini menggambarkan perjalanan, bukan berarti Passport baru dicatat pada akhir. Passport berkembang melalui event domain sah sepanjang perjalanan. Hasil penilaian kembali harus terhubung ke gap, praktik, dan bukti yang relevan.

| Tindakan | Pemilik kewenangan | Batas AI |
| --- | --- | --- |
| Mengelola identitas dan role | Admin berwenang melalui backend | Tidak mempromosikan role atau menentukan ownership |
| Menerbitkan materi/aturan | Pengelola berwenang setelah review | Boleh mengusulkan draft; tidak menerbitkan sendiri |
| Memeriksa bukti | Verifier/validator sesuai assignment | Bantuan pemeriksaan tidak membuktikan keaslian atau keamanan kerja |
| Mengevaluasi praktik | Trainer/reviewer berwenang dengan rubrik | Tidak mengubah hasil evaluasi secara bebas |
| Menghasilkan readiness | Engine deterministik dari input sah dan aturan disetujui | Tidak menetapkan status independen |
| Menyetujui baseline/rilis | Governance dan reviewer rilis | QA agent atau metrik PASS tidak menggantikan persetujuan |
| Menetapkan sertifikasi resmi | Pihak resmi eksternal sesuai kewenangan | Tidak dilakukan TERAS atau agent |

## 5. Aturan readiness yang lengkap dan dapat diaudit

Bagian ini adalah kebutuhan semantik, bukan enum status baru atau perubahan engine saat ini. Pemetaan ke kontrak status kanonis dilakukan setelah review aturan.

### 5.1 Urutan pemeriksaan

1. Pastikan peserta, enrollment, pathway, dan versi framework yang dipakai sah.
2. Pastikan seluruh persyaratan wajib mempunyai input dan review yang sah.
3. Periksa safety kritis. Kegagalan kritis memblokir readiness; data kritis yang belum dinilai tidak boleh ditafsirkan sebagai lulus.
4. Periksa kelulusan setiap unit wajib; rata-rata lintas unit tidak menutupi unit yang belum memenuhi syarat.
5. Periksa kualitas, relevansi, kecukupan, provenance, dan keberlakuan bukti sesuai aturan yang telah direview.
6. Periksa reassessment yang diwajibkan akibat perubahan relevan, koreksi, atau remediasi.
7. Hasilkan keputusan beserta alasan menggunakan aturan yang disetujui.

| Kondisi | Hasil semantik yang wajib jelas |
| --- | --- |
| Ada safety kritis gagal | Tidak siap; alasan keselamatan ditampilkan |
| Input atau review kritis belum lengkap | Kesiapan belum dapat ditetapkan; tidak boleh READY |
| Ada unit wajib belum memenuhi syarat | Tidak siap; unit dan tindakan perbaikan ditunjukkan |
| Reassessment diwajibkan tetapi belum selesai | Menunggu reassessment |
| Seluruh persyaratan sah dan terpenuhi | Siap untuk tahap persiapan yang dimaksud, bukan tersertifikasi |

### 5.2 Koreksi terhadap angka contoh blueprint asal

- Rentang 70–79 harus mempunyai perlakuan eksplisit jika model ambang tersebut kelak dipakai.
- Bobot dan ambang harus beralasan per skema, direview, serta diuji; jangan diambil langsung dari contoh.
- Masa berlaku tidak otomatis enam bulan untuk semua bukti. Gunakan aturan per jenis bukti, skema, sumber, dan risiko.
- Remediasi baru tidak otomatis membuat seluruh bukti kedaluwarsa. Tentukan kriteria terkait yang memerlukan reassessment.
- Jangan mengganti engine, status, atau histori yang ada tanpa pemetaan kompatibilitas dan persetujuan perubahan.

### 5.3 Snapshot keputusan

Setiap keputusan memerlukan konteks peserta/pathway yang sah, versi framework dan aturan, referensi input serta review yang digunakan, hasil dan alasan, waktu server, dan hubungan ke keputusan sebelumnya jika ada.

Keputusan baru ditambahkan sebagai histori. Perubahan aturan tidak menulis ulang hasil lama secara diam-diam. Data privat ini tetap berada pada sistem domain terotorisasi, bukan pada telemetry provider.

## 6. Konten SKTTK dan paket pengetahuan

Katalog tidak dibangun sebagai seluruh kombinasi bidang × usaha × jabatan × level yang diasumsikan valid. Tampilkan hanya kombinasi yang telah dipetakan dan diverifikasi untuk cakupan yang dipilih.

Fondasi regulasi saat ini dibatasi pada Permen ESDM 6/2021 sebagai rujukan otoritas domain dan Permen ESDM 5/2021 sebagai konteks regulasi. Penyebutan ini bukan penilaian legal bahwa keduanya mencukupi atau paling mutakhir untuk semua skema. Penambahan SKKNI, PUIL, SOP, atau sumber lain memerlukan review versi, relevansi, otoritas, dan hak penggunaan.

### 6.1 Metadata minimum paket

| Kelompok | Isi |
| --- | --- |
| Identitas | ID stabil, versi, domain, track, cakupan pathway/skema |
| Sumber | Identitas dokumen, versi, fingerprint, halaman/pasal, tanggal review |
| Isi | Unit, elemen, KUK dan hubungan spesifiknya |
| Mapping | Outcome LMS, activity, practice, evidence requirement, diagnostic |
| Safety | Kriteria kritis, alasan penetapan, sumber, persetujuan ahli |
| Publikasi | Status draft/review/aktif/retired yang dipetakan ke model kanonis |
| Tata kelola | Reviewer berwenang, hasil review, dampak perubahan, aturan pinning versi |

Metadata sumber global tidak cukup untuk membuktikan seluruh isi. Kutipan dan review harus dapat ditelusuri sampai ke isi yang digunakan.

### 6.2 Gate sebelum konten resmi

1. Sumber dan isi bidang yang dipilih telah ditinjau manusia.
2. Hubungan unit–elemen–KUK–LMS–practice–evidence–diagnostic konsisten.
3. Perubahan katalog tidak dapat diam-diam memutus hubungan yang masih dipakai.
4. Safety telah direview ahli domain.
5. Dampak versi terhadap peserta aktif dan histori diputuskan.
6. Publikasi disetujui oleh pihak berwenang.

Seed atau draft sintetis harus tetap jelas non-otoritatif. Jangan mengisi unit/KUK resmi dengan tebakan model.

## 7. Arsitektur agentic: kemampuan dahulu, framework kemudian

### 7.1 Struktur target konseptual

Web TERAS → autentikasi dan otorisasi Core → pengambilan fakta terotorisasi → minimisasi payload → kemampuan agent yang diizinkan → validasi output → penyajian lokal → telemetry aman.

Core tetap menangani ownership, keputusan, histori, storage, dan transisi. Gateway kanal dan orkestrator eksternal bukan sumber kewenangan baru.

### 7.2 Batas kemampuan

| Kemampuan | Perlakuan |
| --- | --- |
| Trainer intelligence yang telah disetujui | Pertahankan kontrak dan buktikan baseline operasional |
| Penjelasan progres/readiness | Gunakan fakta dan narasi lokal terotorisasi; jangan menambah klaim |
| Kurasi regulasi/soal | Draft back-office dengan review manusia; sumber dan hak penggunaan wajib diperiksa |
| Tutor teknis generatif | Kemampuan baru; membutuhkan persetujuan batas data, grounding, keselamatan, dan evaluasi |
| Review foto/dokumen dan simulasi suara | Kemampuan baru; bukan pengganti verifier atau asesor berwenang |
| Pengingat kanal pesan | Memerlukan consent kanal, pemetaan identitas aman, minimisasi, dan kontrol berhenti |

### 7.3 Hermes, OpenClaw, MultiClaw

Ketiganya belum ditetapkan sebagai stack produksi. Sebelum dipilih, catat repository resmi, versi, lisensi, model eksekusi, kebutuhan hosting, penyimpanan konteks, isolasi, tool permissions, pembaruan keamanan, biaya, serta cara menghentikan dan memulihkan layanan.

Bandingkan dengan implementasi yang lebih sederhana pada stack yang ada. Jalankan eksperimen terisolasi tanpa learner nyata dan tanpa akses tulis domain. Adopsi hanya jika manfaat terukur melebihi kompleksitas tambahan.

## 8. Privasi, storage, dan audit

### 8.1 Batas provider

Batas saat ini: provider memilih atau mengurutkan kode fakta opaque dari agregat terotorisasi. TERAS menyusun angka, prose, tindakan, grounding, dan sitasi yang ditampilkan secara lokal. Output provider tidak menjadi klaim otoritatif.

CV, isi bukti, foto, transkrip, passport mentah, identitas stabil, atau domain free text tidak otomatis boleh dikirim ke provider. Perluasan memerlukan persetujuan governance atas tujuan, minimisasi, consent, retensi, akses, dan risiko.

Otorisasi berlaku sebelum pengambilan konteks; minimisasi berlaku sebelum pengiriman. Guardrail prompt tidak menggantikan kontrol akses.

### 8.2 Isolasi

Workspace per agent bukan bukti isolasi peserta. Kontrol harus mencakup peserta, organisasi/kohort sesuai model akses, enrollment, pathway, sesi, cache, memori, file, dan tool. Identitas pemilik diturunkan server-side.

### 8.3 File dan bukti

Unggah harus terotorisasi, tervalidasi jenis/ukuran/isi sesuai risiko, serta dikaitkan hanya ke record milik pengguna yang sah. URL unggah bukan bukti bahwa file telah diterima dan layak dipakai. Pengaitan, verifikasi hasil, akses baca, retensi, dan penanganan kegagalan perlu dibuktikan.

Consent dan kemampuan inspeksi AI tidak membuktikan authenticity. Review manusia tetap diperlukan sesuai kewenangan.

### 8.4 Dua jenis histori

- Passport/domain audit: event perubahan keadaan yang sah, dengan provenance dan hubungan sebab-akibat.
- Agent observability: agregat aman yang cukup untuk mengevaluasi kesehatan dan kualitas.

Jangan menambahkan event Passport untuk setiap respons chat. Jangan menyimpan prompt, isi bukti, identitas learner, atau record individual ke telemetry untuk memudahkan debugging. Kebijakan retensi harus membedakan metadata operasional yang dapat diminimalkan dari histori domain yang harus dipertahankan sesuai kebijakan.

## 9. Evaluasi dan gate rilis

### 9.1 Gate operasional agentic kanonis

| Ukuran | Syarat |
| --- | --- |
| Lingkungan | Produksi yang hendak dinilai |
| Populasi | Run terminal trainer-intelligence: COMPLETED, FAILED, PARTIAL |
| Jendela | Run yang dibuat dalam 30 hari terakhir |
| Sampel | Minimal 100 run nyata |
| Rentang observasi | Selisih waktu run pertama dan terakhir minimal 14 hari |
| Completed | Minimal 95% dari run terminal |
| Failed | Maksimal 1% dari run terminal |
| Fallback | Maksimal 5% dari run terminal |
| p95 | Maksimal 15.000 ms pada latensi terminal valid |

PARTIAL masuk penyebut tetapi bukan completed atau failed. Data tidak tersedia bukan nol. Sampel kurang, periode kurang, atau p95 tidak tersedia tidak boleh dianggap PASS.

Baseline operasional membutuhkan gate metrik produksi PASS, bukti regresi privacy, authorization, append-only protection, dan domain non-mutation yang terkini, penanganan insiden P0/P1 terbuka, serta persetujuan eksplisit governance.

### 9.2 Evaluasi kemampuan baru

Golden set dengan cakupan unit/KUK, safety, pertanyaan ambigu, penolakan, dan input adversarial disusun bersama pakar. Contoh 200 pertanyaan per skema adalah titik awal perencanaan, bukan bukti kecukupan statistik.

| Evaluasi | Definisi yang harus ditetapkan |
| --- | --- |
| Akurasi teknis | Rubrik pakar, penyebut, tingkat keparahan kesalahan, dan hasil per unit |
| Grounding | Sumber sah dan isi sumber mendukung klaim, bukan sekadar sitasi tersedia |
| Safety | Kasus gagal, penolakan tepat, eskalasi, dan hasil per kategori risiko |
| Routing | Intent, biaya salah routing, dan fallback saat ambigu |
| Evidence assistance | Batas kemampuan, false acceptance/rejection, serta review manusia |
| Prediktif | Hasil eksternal yang sah dan berizin; analisis kohort dengan keterbatasan |

Nol respons berbahaya pada test set bukan jaminan risiko nol. Evaluasi offline tidak menggantikan observasi produksi.

### 9.3 Paket bukti kandidat dan keputusan GO

Paket harus mengidentifikasi kandidat kode/deployment, cakupan perubahan, izin dan alur seluruh peran, integritas serta histori, aksesibilitas, keamanan, upload/storage nyata, isolasi, hasil gate agentic, review insiden, dan keputusan governance.

Workflow rilis harus menolak GO jika bukti wajib hilang, tidak sesuai kandidat, tidak cukup mutakhir terhadap perubahan relevan, atau berstatus gagal/belum terverifikasi. Prosedur auth/bootstrap harus sesuai implementasi aktif, bukan panduan provider lama.

Bedakan liveness proses dari readiness dependensi. Tinjau CORS berdasarkan origin produksi yang diizinkan dan model autentikasi. Jangan menyimpulkan eksploitasi tanpa bukti, tetapi jangan menganggap konfigurasi permisif telah aman.

Build sukses, merge, preview hidup, smoke berkala, atau tes lokal PASS bukan persetujuan rilis. Semua tes otomatis pascamerge tetap dipertahankan.

## 10. Roadmap berbasis kriteria selesai

| Tahap | Pekerjaan | Gate keluar | Penanggung jawab peran |
| --- | --- | --- | --- |
| A. Pemetaan keadaan | Cocokkan rekomendasi dengan sistem dan pekerjaan aktif | Matriks tersedia/perlu bukti/perlu perbaikan; tidak ada duplikasi scope | Product dan engineering |
| B. Penutupan MVP | Tutup alur peran, evidence, storage, akses, dan prosedur rilis yang belum terpenuhi | Perjalanan produksi kandidat terbukti; gap wajib ditutup | Engineering, QA, operasi peran |
| C. Baseline agentic | Observasi run nyata, gate, regresi, review insiden | Verified Operational Baseline disetujui | Operasi, keamanan, governance |
| D. Fondasi Path B | Framework, review sumber/relasi/katalog, mapping ke LMS | Prasyarat konten resmi lulus dan tercatat | Pakar domain, kurator, engineering |
| E. Pilot Path B | Satu skema yang disetujui, diagnostic dan aturan readiness tervalidasi | Outcome pilot dan kekurangan ditinjau; tidak ada klaim sertifikasi palsu | Product, pakar, reviewer |
| F. Perluasan | Tutor, kanal, vision, voice, CAT atau multi-agent satu per satu | Gate kemampuan, privasi, operasi, dan persetujuan masing-masing | Governance dan pemilik kemampuan |

Tahap D dapat berkembang paralel dengan observasi operasional, tanpa mengubah scope rilis atau melewati gate konten. Rilis MVP membutuhkan tahap B dan C; jika konten resmi kelak dimasukkan ke scope rilis, gate D dan pilot yang relevan juga wajib.

Durasi tidak ditetapkan sebelum mapping keadaan, kapasitas tim, dan dependensi disepakati. Minimum observasi 14 hari bukan janji selesai 14 hari.

## 11. Landing, komunikasi, dan trust

- Bahasa Indonesia menjadi bahasa utama; istilah teknis diberi penjelasan konsisten.
- Tagline mencerminkan capability, evidence, dan readiness tanpa menjanjikan sertifikasi.
- Disclaimer persiapan terlihat pada landing, hasil evaluasi, portfolio, dan handoff.
- Katalog publik hanya menampilkan skema/cakupan yang telah disetujui; draft diberi label jelas.
- Nama reviewer, mitra, dan logo hanya ditampilkan dengan verifikasi dan izin.
- Klaim pasar mencantumkan sumber serta tanggal; jangan memakai angka yang belum diperiksa.
- SSR/pre-render/SEO diputuskan berdasarkan pengukuran respons publik, metadata, dan hasil crawler; bukan asumsi dari satu kegagalan.
- Mini-diagnostic anonim, jika kelak dibuat, bersifat orientasi dan tidak menghasilkan readiness resmi atau mengikat identitas secara diam-diam.

## 12. Pengelolaan temuan dan keputusan

Gunakan format berikut sebelum menyatakan fitur hilang atau membuka pekerjaan:

| Field | Isi |
| --- | --- |
| Temuan | Perilaku yang diamati, bukan asumsi |
| Bukti | Referensi internal dan waktu pemeriksaan tanpa payload privat |
| Lingkungan/cakupan | Landing, login, backend, test, atau produksi |
| Kepastian | Terbukti, dugaan, belum diperiksa |
| Status | Tersedia, perlu bukti, perlu perbaikan, di luar scope |
| Dampak | Pengguna/peran, integritas, safety, privasi, atau rilis |
| Pemilik | Peran/tim dan dependensi pekerjaan yang sudah ada |
| Kriteria selesai | Hasil terukur dan bukti yang harus disediakan |
| Keputusan | Setuju/tunda/tolak, pihak berwenang, dan alasan |

### Checklist persetujuan blueprint

- [x] Arah revisi disetujui pengguna.
- [x] MVP, fondasi Path B, dan pengembangan lanjutan dipisahkan.
- [x] Batas AI dan sumber kebenaran dinyatakan.
- [x] Tidak mengadopsi angka readiness contoh sebagai kebijakan sah.
- [x] Tidak mewajibkan penggantian stack untuk MVP.
- [ ] Pemilik operasional dan reviewer tiap area ditetapkan.
- [ ] Mapping backlog serta keadaan terbaru diperiksa sebelum implementasi.
- [ ] Skema pilot, sumber konkret, dan kapasitas review domain ditetapkan.
- [ ] Bukti kandidat rilis serta baseline operasional disetujui pihak berwenang.

### Rujukan dan batas penelaahan

- Blueprint Notion yang diunggah pengguna.
- replit.md: batas produk, pemisahan konsep keputusan, kewajiban peran, dan gate rilis.
- docs/skttk-integration-review.md: relasi framework, LMS, diagnostic, dan batas konten.
- scripts/AGENTIC_OPERATIONAL_RUNBOOK.md: populasi, metrik, regresi, insiden, dan governance.

Dokumen ini tidak memverifikasi ulang produksi, status seluruh backlog, legalitas regulasi terkini, kemampuan framework eksternal, atau kelayakan klinis/statistik evaluasi. Tidak ada angka dari audit sebelumnya yang diperlakukan sebagai kondisi produksi terkini. Publikasi ke workspace Notion dan pelaksanaan perubahan aplikasi merupakan langkah terpisah.