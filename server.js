// server.js
// Microservice ringkas: terima senarai URL gambar (yang DAH ada text overlay dari
// Cloudinary — kita tak render text di sini, cuma assemble jadi video), gabungkan
// jadi satu video MP4 slideshow guna FFmpeg, pulangkan video tu terus (streamed).
//
// Kenapa perlu servis ni: TikTok Shop "Add Link" produk cuma available untuk VIDEO
// post, bukan photo carousel — jadi kita perlukan cara tukar 4 gambar hook/curiosity
// (yang sedia ada) jadi satu video pendek untuk TikTok, supaya Azrin boleh attach
// link produk selepas post disiapkan.

const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const os = require("os");
const { v4: uuidv4 } = require("uuid");
const ffmpegPath = require("ffmpeg-static");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
// Kalau nak proteksi endpoint (elak orang lain guna servis percuma ni), set SERVICE_SECRET
// sebagai environment variable di Render Dashboard, dan Worker akan hantar header ni.
const SERVICE_SECRET = process.env.SERVICE_SECRET || null;

function downloadFile(url, filepath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error(`Terlalu banyak redirect untuk ${url}`));
      return;
    }

    const client = url.startsWith("https") ? https : http;
    // Agent BARU setiap request (keepAlive false) — elak sebarang isu connection-reuse/pooling
    // yang boleh punca response tersalah alamat/campur antara request berturutan.
    const agent = new client.Agent({ keepAlive: false });

    const request = client.get(url, { agent, headers: { "Cache-Control": "no-cache" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); // buang response lama sepenuhnya dulu
        downloadFile(response.headers.location, filepath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Gagal muat turun ${url}: HTTP ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(filepath);
      response.pipe(file);

      file.on("finish", () => {
        file.close((closeErr) => {
          if (closeErr) {
            reject(closeErr);
            return;
          }
          // Verify fail betul-betul ada kandungan (elak frame kosong/corrupt dalam video)
          const stat = fs.statSync(filepath);
          if (stat.size === 0) {
            reject(new Error(`Fail kosong selepas muat turun: ${url}`));
            return;
          }
          resolve();
        });
      });
      file.on("error", (err) => reject(err));
    });

    request.on("error", (err) => reject(err));
  });
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "FFmpeg slideshow microservice berjalan",
    ffmpeg_path: ffmpegPath,
    version: "2026-08-04-normalize-v4" // tukar string ni bila update, untuk confirm deploy terkini live
  });
});

app.post("/generate-video", async (req, res) => {
  if (SERVICE_SECRET) {
    const authHeader = req.headers["x-service-secret"];
    if (authHeader !== SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized — SERVICE_SECRET tak sepadan" });
    }
  }

  const { images, duration_per_image } = req.body;

  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "Field 'images' (array URL gambar) wajib diisi" });
  }
  if (images.length > 15) {
    return res.status(400).json({ error: "Maksimum 15 gambar setiap permintaan" });
  }

  const durationPerImage = Math.max(1, Math.min(10, Number(duration_per_image) || 3));
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1. Muat turun semua gambar, simpan dengan nama berurutan, KEMUDIAN normalize
    //    (re-encode + scale/pad) SETIAP satu secara BERASINGAN sebelum assemble.
    //    Ni elak sebarang quirk dari format asal (JPEG progressive/chroma-subsampling
    //    berbeza dari Cloudinary) yang mungkin punca FFmpeg "skip"/duplicate frame
    //    secara senyap semasa proses assembly gabungan.
    const downloadLog = [];
    for (let i = 0; i < images.length; i++) {
      const rawFilepath = path.join(workDir, `raw${String(i).padStart(3, "0")}.jpg`);
      await downloadFile(images[i], rawFilepath);

      const buf = fs.readFileSync(rawFilepath);
      let simpleHash = 0;
      for (let b = 0; b < Math.min(buf.length, 1000); b++) simpleHash = (simpleHash + buf[b] * (b + 1)) % 999999937;
      downloadLog.push({ index: i, url: images[i], size: buf.length, hash: simpleHash });
      console.log(`Download img${i}: size=${buf.length} hash=${simpleHash} url=${images[i]}`);

      // Normalize: scale+pad ke 720x1280 KONSISTEN, re-encode sebagai baseline JPEG bersih.
      const normalizedFilepath = path.join(workDir, `img${String(i).padStart(3, "0")}.jpg`);
      await new Promise((resolve, reject) => {
        execFile(
          ffmpegPath,
          [
            "-y", "-i", rawFilepath,
            "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2",
            "-q:v", "3",
            normalizedFilepath
          ],
          { maxBuffer: 1024 * 1024 * 10 },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`Normalize gambar ${i} gagal: ${error.message}\n${stderr || ""}`.slice(0, 1000)));
              return;
            }
            resolve();
          }
        );
      });
      const normStat = fs.statSync(normalizedFilepath);
      console.log(`Normalized img${i}: size=${normStat.size}`);
    }
    console.log("SEMUA download log:", JSON.stringify(downloadLog));

    const outputPath = path.join(workDir, "output.mp4");

    // 2. Bina fail senarai untuk CONCAT DEMUXER — gambar SUDAH normalize (saiz/format
    //    konsisten), jadi assembly ni tak perlukan scale/pad lagi, cuma gabung + fps.
    const fileListPath = path.join(workDir, "filelist.txt");
    let fileListContent = "";
    for (let i = 0; i < images.length; i++) {
      const imgName = `img${String(i).padStart(3, "0")}.jpg`;
      fileListContent += `file '${imgName}'\nduration ${durationPerImage}\n`;
    }
    // Concat demuxer perlukan fail TERAKHIR diulang tanpa duration (quirk yang didokumenkan) —
    // kalau tidak, gambar terakhir akan "hilang"/durasi tak dikira dengan betul.
    const lastImgName = `img${String(images.length - 1).padStart(3, "0")}.jpg`;
    fileListContent += `file '${lastImgName}'\n`;
    fs.writeFileSync(fileListPath, fileListContent);

    // 3. Assemble jadi video — gambar dah SAMA saiz (720x1280), cuma perlu fps + format.
    // Optimize untuk memory RENDAH (Render free tier cuma 512MB RAM):
    // - Resolusi rendah (720x1280) — dah dinormalize di langkah 1
    // - preset "veryfast" — kurangkan memory lookahead/motion-search encoder
    // - rc-lookahead dihadkan — kurangkan buffer B-frame
    // TikTok WAJIB frame rate minimum 23fps (kita guna 24fps, sikit di atas had minimum).
    const ffmpegArgs = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", fileListPath,
      "-vf", "fps=24,format=yuv420p",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-x264-params", "rc-lookahead=10:ref=1",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath
    ];

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, ffmpegArgs, { cwd: workDir, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`FFmpeg gagal: ${error.message}\n${stderr || ""}`.slice(0, 2000)));
          return;
        }
        resolve();
      });
    });

    // 3. Stream video hasil terus sebagai response
    const stat = fs.statSync(outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    // Sertakan ringkasan download (saiz + hash setiap gambar) sebagai header — untuk debug
    // tanpa perlu check Render logs. Base64 sebab header value tak boleh ada newline/khas.
    try {
      const summary = downloadLog.map((d) => `${d.index}:${d.size}:${d.hash}`).join(",");
      res.setHeader("X-Download-Summary", Buffer.from(summary).toString("base64"));
    } catch (e) { /* tak kritikal, abaikan kalau gagal */ }
    const videoStream = fs.createReadStream(outputPath);
    videoStream.pipe(res);
    videoStream.on("close", () => {
      fs.rmSync(workDir, { recursive: true, force: true });
    });
    videoStream.on("error", () => {
      fs.rmSync(workDir, { recursive: true, force: true });
    });
  } catch (err) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
    console.error("generate-video error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg slideshow microservice listening on port ${PORT}`);
});
