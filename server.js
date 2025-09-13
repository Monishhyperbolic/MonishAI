require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('canvas'); // Add 'canvas' npm package for image resize
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

// Init DB (unchanged)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    answer TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('Error creating table:', err);
  });
});

// Helper: Resize and compress image
async function resizeImage(buffer, maxWidth = 640, quality = 0.7) {
  const img = await loadImage(buffer);
  const canvas = createCanvas(Math.min(maxWidth, img.width), (img.width / img.height) * Math.min(maxWidth, img.width));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer('image/jpeg', { quality });
}

// Upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let tempPath = req.file.path;
  try {
    // Validate image
    if (!req.file.mimetype.startsWith('image/jpeg')) {
      return res.status(400).json({ error: 'Only JPEG images are supported' });
    }

    // Read, resize, and compress image
    let imgBuffer = fs.readFileSync(tempPath);
    console.log('Original image size (bytes):', imgBuffer.length);
    imgBuffer = await resizeImage(imgBuffer); // Resize to reduce size
    console.log('Resized image size (bytes):', imgBuffer.length);
    if (imgBuffer.length > 10 * 1024 * 1024) { // 10MB limit
      throw new Error('Image too large after compression');
    }
    const b64 = imgBuffer.toString('base64');

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
    }

    // Groq API call with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct", // Confirmed vision model
        messages: [
          { role: "user", content: [
            { type: "text", text: "Interpret this image and give the answer (code, pseudocode, MCQ solution, etc.):" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ] }
        ],
        max_tokens: 700
      })
    });
    clearTimeout(timeoutId);

    let errorText;
    try {
      errorText = await groqRes.text();
    } catch (parseErr) {
      throw new Error(`Failed to read Groq response: ${parseErr.message}`);
    }

    if (!groqRes.ok) {
      console.error('Groq API error:', groqRes.status, errorText);
      return res.status(500).json({ error: `Groq API failed: ${groqRes.status}`, details: errorText });
    }

    let groqJson;
    try {
      groqJson = JSON.parse(errorText);
    } catch (parseErr) {
      console.error('JSON parse error on Groq response:', parseErr, errorText);
      throw new Error('Invalid JSON from Groq API');
    }

    console.log('Groq API response summary:', groqJson.choices?.[0]?.message?.content?.substring(0, 200) + '...');
    const answer = groqJson.choices?.[0]?.message?.content || 'No answer returned from Groq';

    // Store in DB
    db.run('INSERT INTO answers (answer) VALUES (?)', [answer], function (err) {
      if (err) {
        console.error('DB insert error:', err);
        return res.status(500).json({ error: 'Database storage failed', details: err.message });
      }
      console.log('Answer stored successfully, ID:', this.lastID);
      fs.unlinkSync(tempPath);
      res.json({ success: true, answer: answer.substring(0, 100) + '...' });
    });
  } catch (err) {
    console.error('Upload processing error:', err.message);
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Answers API (unchanged, with cache headers)
app.get('/answers', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  db.all('SELECT answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20', (err, rows) => {
    if (err) {
      console.error('Error fetching answers:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log('Fetched answers count:', rows.length);
    res.json(rows);
  });
});

// Debug endpoints (unchanged)
app.get('/debug/db', (req, res) => {
  db.all('SELECT * FROM answers ORDER BY id DESC LIMIT 5', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/debug/insert', (req, res) => {
  db.run('INSERT INTO answers (answer) VALUES (?)', ['Test answer from debug'], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Test answer inserted', rowId: this.lastID });
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));