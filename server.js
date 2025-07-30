const express = require('express');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const os = require('os');
const crypto = require('crypto');
const compression = require('compression');
const PQueue = require('p-queue');

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(compression());

// Limit concurrent FFmpeg processes to prevent system overload
const processQueue = new PQueue({ concurrency: os.cpus().length > 2 ? 2 : 1 });

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY
  }
});

const downloadTo = async (url, dir) => {
  const filename = path.basename(url.split('?')[0]) || `audio-${Date.now()}.mp3`;
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

const uploadToR2 = async (bucket, key, stream) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: stream,
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
      `[0:a]afade=t=in:curve=sin:d=3,volume=1.2[intro];
       [2:a]afade=t=out:curve=sin:d=3,volume=1.2[outro];
       [intro][1:a][outro]concat=n=3:v=0:a=1[merged];
       [merged]loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
      '-map', '[out]',
      '-c:a', 'libmp3lame',
      '-q:a', '1', // Higher quality (0-9, 0 is best)
      '-threads', Math.max(1, os.cpus().length - 1).toString(),
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
    return res.status(400).json({ error: 'Exactly 3 audio files and output filename required' });
  }

  try {
    const tmpDir = path.join(os.tmpdir(), `faded-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tmpDir, { recursive: true });
// Add this early in your server.js
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// Modify the start command at the bottom:
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CPU cores: ${require('os').cpus().length}`);
});
    // Process in queue to prevent system overload
    await processQueue.add(async () => {
      const [intro, main, outro] = await Promise.all(
        files.map(url => downloadTo(url, tmpDir))
      );

      const outputPath = path.join(tmpDir, output);
      await runFFmpegMerge(intro, main, outro, outputPath);

      const fileStream = fs.createReadStream(outputPath);
      const finalUrl = await uploadToR2(bucket, output, fileStream);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });

      res.json({ 
        success: true, 
        url: finalUrl,
        message: 'Audio merged with professional fade effects'
      });
    });
  } catch (err) {
    console.error('Merge error:', err);
    res.status(500).json({ 
      error: 'Audio processing failed',
      details: err.message 
    });
  }
});

// Health check endpoint
app.get('/health', (_, res) => {
  res.status(200).json({
    status: 'healthy',
    memory: process.memoryUsage(),
    load: os.loadavg()
  });
});

app.get('/', (_, res) => res.send('🎧 Professional Podcast Fade Merge Server'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CPU cores: ${os.cpus().length}`);
  console.log(`FFmpeg path: ${ffmpegPath}`);
});
