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
  if (err) console.error('Database connect error:', err);
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

// Upload endpoint (robust to unexpected Groq responses)
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const tempPath = req.file.path;
  try {
    // File checks
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
    if (!process.env.GROQ_API_KEY) {
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
    }

    // Only use supported production vision model!
    const model = "meta-llama/llama-guard-4-12b";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyze the image. For every question, return ONLY a JSON array like [{"question": "...", "answer": "..."}]. No other text.`
              },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${b64}` }
              }
            ]
          }
        ],
        max_tokens: 700
      })
    });
    clearTimeout(timeoutId);

    let responseText = await groqRes.text();
    if (!groqRes.ok) {
      console.error("Groq API error response:", responseText);
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: `Groq API failed: ${groqRes.status}`, details: responseText });
    }

    let qnaArray = [];
    try {
      const groqJson = JSON.parse(responseText);
      let rawContent = groqJson.choices?.[0]?.message?.content;

      // Robust handling: parse JSON array, or plain string
      if (typeof rawContent === 'string' && rawContent.trim().startsWith('[')) {
        qnaArray = JSON.parse(rawContent);
        if (!Array.isArray(qnaArray)) qnaArray = [qnaArray];
      } else if (typeof rawContent === 'string') {
        // Single string fallback
        qnaArray = [{ question: "Status", answer: rawContent }];
      } else {
        // Unexpected: fallback to empty array
        qnaArray = [{ question: "Status", answer: "No content returned from Groq." }];
      }
    } catch (err) {
      console.error("Invalid JSON from Groq:", responseText);
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: 'Invalid JSON from Groq', details: responseText });
    }

    // Format output and store in DB
    const safeResults = qnaArray
      .filter(obj => obj && typeof obj === 'object')
      .map(obj => {
        const question = String(obj.question || 'No question found').trim();
        const answer = String(obj.answer || 'No answer found').trim();
        return `Question: ${question} Answer: ${answer}`;
      });

    qnaArray.forEach(obj => {
      const question = String(obj.question || 'No question found').trim();
      const answer = String(obj.answer || 'No answer found').trim();
      db.run('INSERT INTO answers (question, answer) VALUES (?, ?)', [question, answer]);
    });

    fs.unlinkSync(tempPath);
    res.json(safeResults);
  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    console.error("Server error:", err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Answers endpoint
app.get('/answers', (req, res) => {
  db.all('SELECT question, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Server error while fetching answers.' });
    }
    const safeResults = (rows || []).map(row => {
      const question = String(row?.question || 'No question').trim();
      const answer = String(row?.answer || 'No answer').trim();
      const timestamp = String(row?.timestamp || 'No time').trim();
      return `Question: ${question} Answer: ${answer} Time: ${timestamp}`;
    });
    res.json(safeResults);
  });
});

// Debug endpoint
app.get('/debug/db', (req, res) => {
  db.all('SELECT * FROM answers ORDER BY id DESC LIMIT 5', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Debug error' });
    res.json(rows || []);
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
