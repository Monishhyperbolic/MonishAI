require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pRetry = require('p-retry');

const app = express();
const UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');
const DB_PATH = path.join(process.cwd(), 'data', 'answers.db');

// Ensure data directory exists
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });
let db; // Will be initialized after error handlers

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Don't exit; log and continue if possible
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit; log and continue
});

// Initialize DB with error handling
function initDB() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Database connection error:', err);
        reject(err);
      } else {
        console.log('Connected to SQLite database');
        resolve();
      }
    });
  });
}

// Table setup
function setupTable() {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('DB not initialized'));
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT DEFAULT '',
        answer TEXT DEFAULT '',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) {
          console.error('Table create error:', err);
          reject(err);
        } else {
          db.all("PRAGMA table_info(answers)", (e2, columns) => {
            if (e2) {
              console.error('PRAGMA error:', e2);
              reject(e2);
              return;
            }
            const names = columns.map(c => c.name);
            if (!names.includes('question')) {
              db.run('ALTER TABLE answers ADD COLUMN question TEXT DEFAULT ""', reject);
            } else {
              resolve();
            }
            if (!names.includes('answer')) {
              db.run('ALTER TABLE answers ADD COLUMN answer TEXT DEFAULT ""', reject);
            } else {
              resolve();
            }
          });
        }
      });
    });
  });
}

// Initialize DB on startup
async function startDB() {
  try {
    await initDB();
    await setupTable();
  } catch (err) {
    console.error('Failed to initialize DB:', err);
    // Continue without DB for now; endpoints will handle gracefully
  }
}
startDB();

app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const tempPath = req.file.path;
  try {
    if (!req.file.mimetype.startsWith('image/jpeg')) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Only JPEG images are supported' });
    }

    const imgBuffer = fs.readFileSync(tempPath);
    if (imgBuffer.length > 5 * 1024 * 1024) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
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

    const userPrompt = "Based on the image, generate one relevant question about the content and provide a concise answer to it.";

    const perplexityRes = await pRetry(() => fetch('https://api.perplexity.ai/chat/completions', {
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
        max_tokens: 200
      })
    }), { retries: 3 });

    let responseText = await perplexityRes.text();
    if (!perplexityRes.ok) {
      console.error("Perplexity API error:", responseText);
      fs.unlinkSync(tempPath);
      return res.status(500).json({ error: `Perplexity API failed: ${perplexityRes.status}`, details: responseText });
    }

    try {
      const pplxJson = JSON.parse(responseText);
      const response = pplxJson.choices?.[0]?.message?.content || 'No answer returned';
      const parts = response.split('Answer: ');
      const question = parts[0]?.replace('Question: ', '')?.trim() || 'What is in the image?';
      const answer = parts[1]?.trim() || response;

      // Store in DB if available
      if (db) {
        db.run('INSERT INTO answers (question, answer) VALUES (?, ?)', [question, answer], (err) => {
          if (err) console.error('DB insert error:', err);
        });
      } else {
        console.warn('DB not available; skipping insert');
      }

      fs.unlinkSync(tempPath);
      return res.json({ question, answer });
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
  if (!db) {
    return res.json([]); // Graceful fallback
  }
  db.all('SELECT question, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20', (err, rows) => {
    if (err) {
      console.error('DB query error:', err);
      return res.status(500).json({ error: 'Server error while fetching answers.' });
    }
    res.json(rows.map(row => ({
      question: row.question,
      answer: row.answer,
      timestamp: row.timestamp
    })));
  });
});

app.get('/debug/db', (req, res) => {
  if (!db) {
    return res.json({ error: 'DB not available' });
  }
  db.all('SELECT * FROM answers ORDER BY id DESC LIMIT 5', (err, rows) => {
    if (err) {
      console.error('Debug error:', err);
      return res.status(500).json({ error: 'Debug error' });
    }
    res.json(rows);
  });
});

// Bind to Railway's required host/port
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
});