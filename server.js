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
const { default: PQueue } = require('p-queue');

// Initialize environment and error handlers first
dotenv.config();

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(compression());

// Configuration
const PORT = process.env.PORT || 3000;
const processQueue = new PQueue({ concurrency: os.cpus().length > 2 ? 2 : 1 });

// S3 Client setup
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY
  }
});

// Utility functions
const downloadTo = async (url, dir) => {
  const filename = path.basename(url.split('?')[0]) || `audio-${Date.now()}.mp3`;
  const dest = path.join(dir, filename);

  await fs.promises.mkdir(dir, { recursive: true });
  const writer = fs.createWriteStream(dest);

  const resp = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 180000
  });

  await new Promise((resolve, reject) => {
    resp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
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
      '-q:a', '1',
      '-threads', Math.max(1, os.cpus().length - 1).toString(),
      '-y',
      outputPath
    ]);

    ffmpeg.stderr.on('data', data => console.log(`FFmpeg: ${data}`));
    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with ${code}`)));
  });
};

// Routes
app.post('/merge-faded', async (req, res) => {
  try {
    const { files, output, bucket = 'main-podcast' } = req.body;
    
    if (!Array.isArray(files) || files.length !== 3 || !output) {
      return res.status(400).json({ error: 'Exactly 3 audio files and output filename required' });
    }

    const tmpDir = path.join(os.tmpdir(), `faded-${crypto.randomBytes(4).toString('hex')}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const [intro, main, outro] = await Promise.all(
      files.map(url => downloadTo(url, tmpDir))
    );

    const outputPath = path.join(tmpDir, output);
    await runFFmpegMerge(intro, main, outro, outputPath);

    const fileStream = fs.createReadStream(outputPath);
    const finalUrl = await uploadToR2(bucket, output, fileStream);

    // Cleanup
    await fs.promises.rm(tmpDir, { recursive: true, force: true });

    res.json({ 
      success: true, 
      url: finalUrl,
      message: 'Audio merged with professional fade effects'
    });
  } catch (err) {
    console.error('Merge error:', err);
    res.status(500).json({ 
      error: 'Audio processing failed',
      details: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
});

app.get('/health', (_, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (_, res) => res.send('🎧 Professional Podcast Fade Merge Server'));

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CPU cores: ${os.cpus().length}`);
  
  // Start keepalive in production
  if (process.env.NODE_ENV === 'production') {
    const { exec } = require('child_process');
    exec('node keepalive.js', (error) => {
      if (error) console.error('Keepalive failed to start:', error);
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
