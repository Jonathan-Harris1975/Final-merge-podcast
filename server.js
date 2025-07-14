import express from 'express';
import axios from 'axios';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '50mb' }));

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY
  }
});

const downloadTo = async (url, dir) => {
  const filename = path.basename(url.split('?')[0]);
  const dest = path.join(dir, filename);

  fs.mkdirSync(dir, { recursive: true });
  const writer = fs.createWriteStream(dest);

  const resp = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 180000
  });

  await new Promise((res, rej) => {
    resp.data.pipe(writer);
    writer.on('finish', res);
    writer.on('error', rej);
  });

  return dest;
};

const uploadToR2 = async (bucket, key, buffer) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: 'audio/mpeg'
    })
  );
  return `${process.env.R2_ENDPOINT}/${bucket}/${key}`;
};

const runFFmpeg = (inputListPath, outputFilePath) => {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-f', 'concat',
      '-safe', '0',
      '-i', inputListPath,
      '-c', 'copy',
      outputFilePath
    ]);

    ffmpeg.stderr.on('data', (data) => {
      console.log(`FFmpeg: ${data.toString()}`);
    });

    ffmpeg.on('close', (code) => {
      code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
};

// Final full merge (intro + main + outro)
app.post('/merge-files', async (req, res) => {
  res.setTimeout(300000); // 5 min

  const { files, output, bucket = 'main-podcast' } = req.body;
  if (!Array.isArray(files) || files.length !== 3 || !output) {
    return res.status(400).json({ error: 'Exactly 3 files and output name required' });
  }

  try {
    const tmpDir = `/tmp/final-merge-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });

    const localFiles = [];
    for (const u of files) localFiles.push(await downloadTo(u, tmpDir));

    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, localFiles.map(f => `file '${f}'`).join('\n'));

    const mergedOut = path.join(tmpDir, output);
    await runFFmpeg(listFile, mergedOut);

    const buf = fs.readFileSync(mergedOut);
    const pub = await uploadToR2(bucket, output, buf);

    res.json({ uploaded: true, filename: output, url: pub });
  } catch (err) {
    console.error('Final merge error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/status', (_, res) => res.send('Final merge server live 🎧'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Final merge server on port ${PORT}`));
