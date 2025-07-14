import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import ffmpegPath from 'ffmpeg-static';
import dotenv from 'dotenv';

dotenv.config();

// Resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '20mb' }));

// AWS R2 setup
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

  const resp = await axios({ url, method: 'GET', responseType: 'stream', timeout: 180000 });
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
      '-vn',
      '-acodec', 'libmp3lame',
      '-b:a', '128k',
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

// Final merge endpoint
app.post('/merge-files', async (req, res) => {
  res.setTimeout(300000); // 5 mins timeout for long merges

  const { files, output, bucket = 'main-podcast' } = req.body;
  if (!Array.isArray(files) || files.length !== 3 || !output) {
    return res.status(400).json({ error: 'Provide exactly 3 files and an output name.' });
  }

  try {
    const tmpDir = `/tmp/final-merge-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });

    const localFiles = [];
    for (const url of files) {
      const local = await downloadTo(url, tmpDir);
      localFiles.push(local);
    }

    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, localFiles.map(f => `file '${f}'`).join('\n'));

    const outputFilePath = path.join(tmpDir, output);
    await runFFmpeg(listFile, outputFilePath);

    const buffer = fs.readFileSync(outputFilePath);
    const publicUrl = await uploadToR2(bucket, output, buffer);

    res.json({ uploaded: true, filename: output, url: publicUrl });
  } catch (err) {
    console.error('Merge error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/status', (_, res) => res.send('🎧 Final merge server is live.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎙️ Final merge server running on port ${PORT}`));
