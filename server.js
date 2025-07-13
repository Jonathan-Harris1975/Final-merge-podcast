import express from "express";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import tmp from "tmp";
import { fileURLToPath } from "url";
import path from "path";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Handle final merge
app.post("/main-podcast", async (req, res) => {
  const { files, output } = req.body;

  if (!Array.isArray(files) || files.length !== 3) {
    return res.status(400).json({ error: "Exactly 3 files required: intro, main, outro" });
  }

  try {
    const tempFiles = await Promise.all(files.map(async (url) => {
      const response = await axios.get(url, { responseType: "stream" });
      const temp = tmp.fileSync({ postfix: ".mp3" });
      const writer = fs.createWriteStream(temp.name);
      response.data.pipe(writer);
      await new Promise((resolve) => writer.on("finish", resolve));
      return temp.name;
    }));

    const mergedFile = tmp.tmpNameSync({ postfix: ".mp3" });

    await new Promise((resolve, reject) => {
      const command = ffmpeg();
      tempFiles.forEach(file => command.input(file));
      command
        .on("error", reject)
        .on("end", resolve)
        .mergeToFile(mergedFile);
    });

    res.sendFile(mergedFile, (err) => {
      tempFiles.forEach(fs.unlinkSync);
      fs.unlinkSync(mergedFile);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to merge podcast segments." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Final merge server running on port ${PORT}`));
