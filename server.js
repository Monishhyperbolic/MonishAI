const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const db = new sqlite3.Database('/data/answers.db');
const upload = multer({ dest: '/data/uploads' });


// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database and table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      answer TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Upload endpoint to process image with Groq API
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.sendStatus(400);
  }

  try {
    // Read the image file and convert to base64
    const imgBuffer = fs.readFileSync(req.file.path);
    const base64Image = imgBuffer.toString('base64');

    // Make Groq API request
    const response = await fetch('https://api.groq.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Interpret this image and give the answer (code, pseudocode, MCQ solution, etc.):" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }
        ],
        max_tokens: 700,
      }),
    });

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || 'No answer returned';

    // Store answer in database
    db.run('INSERT INTO answers (answer) VALUES (?)', [answer]);

    // Remove the uploaded file
    fs.unlinkSync(req.file.path);

    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

// Retrieve last 20 answers
app.get('/answers', (req, res) => {
  db.all(
    'SELECT answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20',
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
