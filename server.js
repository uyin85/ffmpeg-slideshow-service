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

function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(filepath);
    client
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          // Ikut redirect sekali (Cloudinary/media-proxy kadang redirect)
          file.close();
          fs.unlinkSync(filepath);
          downloadFile(response.headers.location, filepath).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          reject(new Error(`Gagal muat turun ${url}: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        try { fs.unlinkSync(filepath); } catch (e) {}
        reject(err);
      });
  });
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "FFmpeg slideshow microservice berjalan", ffmpeg_path: ffmpegPath });
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
    // 1. Muat turun semua gambar, simpan dengan nama berurutan (img000.jpg, img001.jpg, ...)
    for (let i = 0; i < images.length; i++) {
      const filepath = path.join(workDir, `img${String(i).padStart(3, "0")}.jpg`);
      await downloadFile(images[i], filepath);
    }

    const outputPath = path.join(workDir, "output.mp4");
    const inputPattern = path.join(workDir, "img%03d.jpg");

    // 2. Assemble jadi video — setiap gambar tunjuk selama `durationPerImage` saat,
    //    scale + pad ke 1080x1920 (format vertical standard TikTok), h264 untuk compatibility luas.
    // Optimize untuk memory RENDAH (Render free tier cuma 512MB RAM):
    // - Resolusi dikurangkan (720x1280 bukan 1080x1920) — kurangkan saiz frame buffer ~50%
    // - fps output dikurangkan (12 bukan 25) — kurangkan jumlah frame perlu diproses/buffer
    // - preset "veryfast" — kurangkan memory lookahead/motion-search encoder
    // - rc-lookahead dihadkan — kurangkan buffer B-frame
    const ffmpegArgs = [
      "-y",
      "-framerate", `1/${durationPerImage}`,
      "-i", inputPattern,
      "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-x264-params", "rc-lookahead=10:ref=1",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath
    ];

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, ffmpegArgs, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
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
