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
app.use(cors()); // Allow all for testing; restrict in prod
app.use(express.static(path.join(__dirname, 'public')));

// Init DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    answer TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('Error creating table:', err);
  });
});

// Upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    // Validate image
    if (!req.file.mimetype.startsWith('image/jpeg')) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Only JPEG images are supported' });
    }

    // Read image and encode to base64
    const imgBuffer = fs.readFileSync(req.file.path);
    const b64 = imgBuffer.toString('base64');
    console.log('Image size (bytes):', imgBuffer.length); // Log for debugging large images

    if (!process.env.GROQ_API_KEY) {
      fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: 'GROQ_API_KEY not set' });
    }

    // Groq vision API request
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct", // Updated to current vision model
        messages: [
          { role: "user", content: [
            { type: "text", text: "Interpret this image and give the answer (code, pseudocode, MCQ solution, etc.):" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ] }
        ],
        max_tokens: 700
      })
    });

    const errorText = await groqRes.text(); // Always fetch text for errors
    if (!groqRes.ok) {
      console.error('Groq API error:', groqRes.status, errorText);
      fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: 'Failed to fetch response from Groq API', details: errorText });
    }

    const groqJson = JSON.parse(errorText); // Parse if ok
    console.log('Groq API response:', JSON.stringify(groqJson, null, 2));
    const answer = groqJson.choices?.[0]?.message?.content || 'No answer returned';

    // Store in DB
    db.run('INSERT INTO answers (answer) VALUES (?)', [answer], function (err) {
      if (err) {
        console.error('Error inserting answer into database:', err);
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ error: 'Failed to store answer in database', details: err.message });
      }
      console.log('Answer stored:', answer.substring(0, 100) + '...', 'Row ID:', this.lastID);
      fs.unlinkSync(req.file.path); // Clean up
      res.json({ success: true, answer }); // Return success with answer for frontend feedback
    });
  } catch (err) {
    console.error('Error processing image upload:', err);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Answers API - Disable caching to avoid 304
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

// Debug endpoints (keep these)
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