require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
const UPLOADS_DIR = '/data/uploads';
const DB_PATH = '/data/answers.db';

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('Database connect error:', err);
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT DEFAULT '',
    answer TEXT DEFAULT '',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, err => { if (err) console.error('Table create error:', err); });
});

// Aggressively compress and return JSON ONLY
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const tempPath = req.file.path;
  try {
    if (!req.file.mimetype.startsWith('image/jpeg')) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Only JPEG images are supported' });
    }
    // Resize/compress for best latency: ~500px wide, quality 70
    let compressedBuffer;
    try {
      compressedBuffer = await sharp(tempPath)
        .resize({ width: 500 })
        .jpeg({ quality: 70 })
        .toBuffer();
    } catch (e) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Error compressing image' });
    }
    fs.unlinkSync(tempPath);

    if (compressedBuffer.length > 2 * 1024 * 1024)
      return res.status(400).json({ error: 'Compressed image too large (max 2MB)' });

    const b64 = compressedBuffer.toString('base64');
    if (!b64.startsWith('/9j/'))
      return res.status(400).json({ error: 'Invalid JPEG base64' });

    if (!process.env.PPLX_API_KEY)
      return res.status(500).json({ error: 'PPLX_API_KEY not configured' });

    const userPrompt = "Describe the image and answer any obvious visual questions.";

    const perplexityRes = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PPLX_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "sonar-reasoning-pro",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
            ]
          }
        ],
        max_tokens: 700
      })
    });

    let responseText = await perplexityRes.text();
    if (!perplexityRes.ok) {
      return res.status(500).json({ error: `Perplexity API failed: ${perplexityRes.status}`, details: responseText });
    }

    let answer;
    try {
      const pplxJson = JSON.parse(responseText);
      answer = pplxJson.choices?.[0]?.message?.content;
      db.run('INSERT INTO answers (question, answer) VALUES (?, ?)', [userPrompt, answer || 'No answer returned']);
    } catch (err) {
      return res.status(500).json({ error: 'Invalid JSON from Perplexity', details: responseText });
    }

    // Always return plain JSON with the Q/A pair
    res.json({
      question: userPrompt,
      answer: answer || 'No answer returned'
    });

  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Always return array of Q/A JSON objects
app.get('/answers', (req, res) => {
  db.all('SELECT question, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Server error while fetching answers.' });
    const safeResults = (rows || []).map(row => ({
      question: String(row?.question || 'No question').trim(),
      answer: String(row?.answer || 'No answer').trim(),
      timestamp: String(row?.timestamp || 'No time').trim()
    }));
    res.json(safeResults);
  });
});

app.get('/debug/db', (req, res) => {
  db.all('SELECT * FROM answers ORDER BY id DESC LIMIT 5', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Debug error' });
    res.json(rows || []);
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
