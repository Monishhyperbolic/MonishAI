require('dotenv').config();

const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch'); // for Groq API call
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const UPLOADS_DIR = '/data/uploads'; // Make sure this matches your Railway volume path
const DB_PATH = '/data/answers.db';

// Ensure upload directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });
const db = new sqlite3.Database(DB_PATH);

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Init DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    answer TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.sendStatus(400);
  try {
    // Read image and encode to base64
    const imgBuffer = fs.readFileSync(req.file.path);
    const b64 = imgBuffer.toString('base64');

    // Groq vision API request
    const groqRes = await fetch('https://api.groq.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [
          { role: "user", content: [
            { type: "text", text: "Interpret this image and give the answer (code, pseudocode, MCQ solution, etc.):" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ] }
        ],
        max_tokens: 700
      })
    });
    const groqJson = await groqRes.json();
    const answer = groqJson.choices?.[0]?.message?.content || 'No answer returned';

    // Store in DB
    db.run('INSERT INTO answers (answer) VALUES (?)', [answer]);
    console.log('Answer stored:', answer); // For debugging!
    fs.unlinkSync(req.file.path); // Clean up

    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing image upload:', err);
    res.sendStatus(500);
  }
});

// Answers API
app.get('/answers', (req, res) => {
  db.all('SELECT answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20', (err, rows) => {
    if (err) {
      console.error('Error fetching answers:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
