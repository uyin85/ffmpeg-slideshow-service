# FFmpeg Slideshow Microservice

Gabungkan senarai gambar (yang **dah** ada text overlay dari Cloudinary) jadi **video MP4** — untuk TikTok Shop "Add Link" produk yang cuma available untuk **video**, bukan photo carousel.

## Cara Deploy ke Render.com (PERCUMA)

### 1. Push code ni ke GitHub

1. Buat repo baru di GitHub (contoh `ffmpeg-slideshow-service`)
2. Upload semua fail dalam folder ni (`server.js`, `package.json`, `README.md`)

### 2. Sambung ke Render.com

1. Daftar/log masuk **render.com** (boleh guna GitHub login terus)
2. Dashboard → **New** → **Web Service**
3. Sambung repo GitHub yang baru dibuat tadi
4. Isi tetapan:
   - **Name**: `ffmpeg-slideshow-service` (atau nama lain)
   - **Region**: Singapore (paling dekat dengan Malaysia)
   - **Branch**: `main`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: **Free**
5. (Opsyenal tapi disyorkan) Klik **"Advanced"** → **Environment Variables** → tambah:
   - Key: `SERVICE_SECRET`
   - Value: (jana password rawak, contoh guna https://passwordsgenerator.net) — ni elak orang lain guna servis percuma Azrin
6. Klik **"Create Web Service"**

### 3. Tunggu deploy siap (~2-5 minit)

Render akan bagi URL macam: `https://ffmpeg-slideshow-service.onrender.com`

### 4. Test

```bash
curl https://ffmpeg-slideshow-service.onrender.com/
```

Patut return: `{"status":"ok","message":"FFmpeg slideshow microservice berjalan",...}`

## ⚠️ Nota penting — Free tier "tidur" lepas 15 minit tak aktif

Kali **pertama** panggil servis lepas ia "tidur", akan ambil **30-50 saat** untuk "bangun" (cold start). Ni **okay** untuk automation background (bukan user tunggu depan skrin) — Worker Cloudflare kita akan tunggu dengan sabar.

## API — POST /generate-video

```json
{
  "images": [
    "https://res.cloudinary.com/.../gambar1.jpg",
    "https://res.cloudinary.com/.../gambar2.jpg",
    "https://res.cloudinary.com/.../gambar3.jpg",
    "https://res.cloudinary.com/.../gambar4.jpg"
  ],
  "duration_per_image": 3
}
```

**Header** (kalau `SERVICE_SECRET` di-set): `X-Service-Secret: <password-tadi>`

**Response**: video MP4 (binary stream), format **1080x1920** (9:16, vertical TikTok), setiap gambar tunjuk `duration_per_image` saat.

## Test tempatan (sebelum deploy)

```bash
npm install
npm start
# Di terminal lain:
curl -X POST http://localhost:3000/generate-video \
  -H "Content-Type: application/json" \
  -d '{"images":["URL1","URL2","URL3","URL4"],"duration_per_image":3}' \
  -o test.mp4
```
