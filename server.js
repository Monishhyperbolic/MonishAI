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

// --- Ensure upload directory exists ---
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

// --- Schema migration for question/answer columns ---
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT,
    answer TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, err => {
    if (err) return console.error('Table create error:', err);
    db.all("PRAGMA table_info(answers)", (e2, columns) => {
      if (e2) return console.error('PRAGMA error:', e2);
      const questionExists = columns.some(c => c.name === 'question');
      const answerExists = columns.some(c => c.name === 'answer');
      if (!questionExists) {
        db.run('ALTER TABLE answers ADD COLUMN question TEXT', ae => {
          if (ae) console.error('Error adding question column:', ae.message);
        });
      }
      if (!answerExists) {
        db.run('ALTER TABLE answers ADD COLUMN answer TEXT', ae => {
          if (ae) console.error('Error adding answer column:', ae.message);
        });
      }
    });
  });
});

// --- Upload endpoint ---
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let tempPath = req.file.path;
  try {
    // Validate image
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
    if (typeof fetch !== 'function') {
      fs.unlinkSync(tempPath);
      throw new Error('fetch is not a function - check node-fetch installation');
    }

    // Prompt: return ONLY a JSON array, with each object including question and answer
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
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Analyze the image. If it contains one or more questions (MCQ, fill-in-the-blank, code, or reasoning), return ONLY a JSON array of objects, each with \"question\" and \"answer\": [{\"question\": \"...\", \"answer\": \"...\"}]. Do not include any explanations, steps, markdown, or code blocks. Your entire output MUST be a valid JSON array and nothing else."
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
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: `Groq API failed: ${groqRes.status}`, details: responseText });
    }

    // Parse the output as a JSON array of question/answer objects
    let qnaArray = [];
    try {
      const groqJson = JSON.parse(responseText);
      let rawContent = groqJson.choices?.[0]?.message?.content || '';
      qnaArray = JSON.parse(rawContent);
      if (!Array.isArray(qnaArray)) qnaArray = [qnaArray];
    } catch (err) {
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: 'Invalid JSON from Groq', details: err?.message || err });
    }

    // Filter out any malformed objects
    qnaArray = qnaArray
      .filter(obj => obj && typeof obj === 'object' && obj.answer && obj.question)
      .map(obj => ({ question: obj.question.trim(), answer: obj.answer.trim() }));

    // Insert all found Q&A objects into DB
    qnaArray.forEach(({ question, answer }) => {
      db.run(
        'INSERT INTO answers (question, answer) VALUES (?, ?)',
        [question, answer]
      );
    });

    fs.unlinkSync(tempPath);
    res.json({ count: qnaArray.length, questions: qnaArray });
  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// --- Recent answers API ---
app.get('/answers', (req, res) => {
  db.all('SELECT question, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Server error while fetching answers.' });
    }
    // Only send fields question and answer for each row, plus timestamp
    res.json(rows.map(row => ({
      question: row.question,
      answer: row.answer,
      timestamp: row.timestamp
    })));
  });
});

// --- Debug endpoints ---
app.get('/debug/db', (req, res) => {
  db.all('SELECT * FROM answers ORDER BY id DESC LIMIT 5', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Debug endpoint error' });
    res.json(rows);
  });
});
app.get('/debug/insert', (req, res) => {
  db.run(
    'INSERT INTO answers (question, answer) VALUES (?, ?)',
    ['Test Q', 'Test answer from debug'],
    function (err) {
      if (err) return res.status(500).json({ error: 'Debug endpoint error' });
      res.json({ message: 'Test answer inserted', rowId: this.lastID });
    }
  );
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
