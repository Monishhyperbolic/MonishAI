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

// Ensure upload directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('Error connecting to database:', err);
  else console.log('Connected to SQLite database');
});

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Init DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT,
    answer TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('Error creating table:', err);
  });
});

// Upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let tempPath = req.file.path;
  try {
    // Validate image
    if (!req.file.mimetype.startsWith('image/jpeg')) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Only JPEG images are supported' });
    }

    // Read image buffer and encode to base64
    const imgBuffer = fs.readFileSync(tempPath);
    if (imgBuffer.length > 10 * 1024 * 1024) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Image too large (max 10MB)' });
    }
    const b64 = imgBuffer.toString('base64');

    // Validate base64
    if (!b64.startsWith('/9j/')) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Invalid JPEG base64 encoding' });
    }

    if (!process.env.GROQ_API_KEY) {
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
    }

    if (typeof fetch !== 'function') {
      fs.unlinkSync(tempPath);
      throw new Error('fetch is not a function - check node-fetch installation');
    }

    // Groq API call
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
          { role: "user", content: [
            { type: "text", text: "Analyze the image. If it contains a question (MCQ, fill-in-the-blank, or otherwise), return a JSON object like { \"question\": \"...\", \"answer\": \"...\" }. For MCQs, 'answer' must be the letter (A/B/C/D). For fill-in-the-blanks, only the exact answer. For code, only return the code in 'answer'. Do not include any explanation." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ] }
        ],
        max_tokens: 700
      })
    });
    clearTimeout(timeoutId);

    let responseText;
    try {
      responseText = await groqRes.text();
    } catch (readErr) {
      fs.unlinkSync(tempPath);
      throw new Error(`Failed to read Groq response: ${readErr.message}`);
    }

    if (!groqRes.ok) {
      console.error('Groq API error:', groqRes.status, responseText);
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: `Groq API failed: ${groqRes.status}`, details: responseText });
    }

    let groqJson;
    try {
      groqJson = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('JSON parse error on Groq response:', parseErr, responseText);
      fs.unlinkSync(tempPath);
      throw new Error('Invalid JSON from Groq API');
    }

    // Extract question and answer fields from Groq output
    let qnaObj;
    let rawContent = groqJson.choices?.[0]?.message?.content || '';
    try {
      qnaObj = JSON.parse(rawContent);
    } catch {
      // fallback: heuristic split or dump as plain answer if format wrong
      qnaObj = { question: '', answer: rawContent.trim() };
    }

    const question = (qnaObj.question || '').trim();
    const answer = (qnaObj.answer || '').trim();

    // Store in DB
    db.run('INSERT INTO answers (question, answer) VALUES (?, ?)', [question, answer], function (err) {
      if (err) {
        console.error('DB insert error:', err);
        fs.unlinkSync(tempPath);
        return res.status(500).json({ error: 'Database storage failed', details: err.message });
      }
      console.log('Answer stored successfully, ID:', this.lastID);
      fs.unlinkSync(tempPath);
      res.json({ success: true, question, answer });
    });
  } catch (err) {
    console.error('Upload processing error:', err.message);
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Answers API
app.get('/answers', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  db.all('SELECT question, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20', (err, rows) => {
    if (err) {
      console.error('Error fetching answers:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log('Fetched answers count:', rows.length);
    res.json(rows);
  });
});

// Debug endpoints
app.get('/debug/db', (req, res) => {
  db.all('SELECT * FROM answers ORDER BY id DESC LIMIT 5', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/debug/insert', (req, res) => {
  db.run('INSERT INTO answers (question, answer) VALUES (?, ?)', ['Test Q', 'Test answer from debug'], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Test answer inserted', rowId: this.lastID });
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
