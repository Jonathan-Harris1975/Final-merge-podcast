const express = require('express');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

dotenv.config();

const app = express();
app.use(express.json({ limit: '20mb' }));

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

const runFFmpegMerge = async (introPath, mainPath, outroPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-i', introPath,
      '-i', mainPath,
      '-i', outroPath,
      '-filter_complex',
      `[0:a]afade=t=in:st=0:d=2[intro]; \
       [2:a]afade=t=out:st=14:d=2[outro]; \
       [intro][1:a][outro]concat=n=3:v=0:a=1[out]`,
      '-map', '[out]',
      '-y',
      outputPath
    ]);

    ffmpeg.stderr.on('data', data => console.log(`FFmpeg: ${data}`));
    ffmpeg.on('close', code => {
      code === 0 ? resolve() : reject(new Error(`FFmpeg exited with ${code}`));
    });
  });
};

app.post('/merge-faded', async (req, res) => {
  const { files, output, bucket = 'main-podcast' } = req.body;
  if (!Array.isArray(files) || files.length !== 3 || !output) {
    return res.status(400).json({ error: '3 files and output required' });
  }

  try {
    const tmpDir = `/tmp/faded-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });

    const [intro, main, outro] = await Promise.all(
      files.map(url => downloadTo(url, tmpDir))
    );

    const outputPath = path.join(tmpDir, output);
    await runFFmpegMerge(intro, main, outro, outputPath);

    const buffer = fs.readFileSync(outputPath);
    const finalUrl = await uploadToR2(bucket, output, buffer);

    res.json({ success: true, url: finalUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_, res) => res.send('🎧 Fade merge server live'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fade server on port ${PORT}`));
