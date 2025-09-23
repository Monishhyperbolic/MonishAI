require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const UPLOADS_DIR = '/data/uploads';
const DB_PATH = '/data/answers.db';

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite database');
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT DEFAULT '',
    answer TEXT DEFAULT '',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, err => {
    if (err) return console.error('Table create error:', err);
    db.all("PRAGMA table_info(answers)", (e2, columns) => {
      if (e2) return console.error('PRAGMA error:', e2);
      const names = columns.map(c => c.name);
      if (!names.includes('question')) {
        db.run('ALTER TABLE answers ADD COLUMN question TEXT DEFAULT ""');
      }
      if (!names.includes('answer')) {
        db.run('ALTER TABLE answers ADD COLUMN answer TEXT DEFAULT ""');
      }
    });
  });
});

app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const tempPath = req.file.path;
  try {
    if (!req.file.mimetype.startsWith('image/jpeg')) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Only JPEG images are supported' });
    }

    const imgBuffer = fs.readFileSync(tempPath);
    if (imgBuffer.length > 10 * 1024 * 1024) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Image too large (max 10MB)' });
    }

    const b64 = imgBuffer.toString('base64');
    if (!b64.startsWith('/9j/')) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Invalid JPEG base64' });
    }

    if (!process.env.PPLX_API_KEY) {
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: 'PPLX_API_KEY not configured' });
    }

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
      console.error("Perplexity API error:", responseText);
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: `Perplexity API failed: ${perplexityRes.status}`, details: responseText });
    }

    try {
      const pplxJson = JSON.parse(responseText);
      const answer = pplxJson.choices?.[0]?.message?.content || 'No answer returned';
      db.run('INSERT INTO answers (question, answer) VALUES (?, ?)', [userPrompt, answer]);
      fs.unlinkSync(tempPath);
      return res.json({ answer });
    } catch (err) {
      console.error("Invalid JSON from Perplexity:", responseText);
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: 'Invalid JSON from Perplexity', details: responseText });
    }
  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    console.error("Server error:", err);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

app.get('/answers', (req, res) => {
  db.all('SELECT question, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Server error while fetching answers.' });
    res.json(rows || []);
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
