const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const pRetry = require('p-retry');

const app = express();
const UPLOADS_DIR = '/tmp/uploads';
const DB_PATH = '/tmp/answers.db';
const PORT = process.env.PORT || 8080;

// Middlewarea
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for file uploads
const upload = multer({ dest: UPLOADS_DIR });

// Initialize SQLite database
let db;
async function initDatabase() {
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) throw new Error(`Database connection error: ${err.message}`);
      console.log('Connected to SQLite database');
    });

    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS answers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          question TEXT DEFAULT '',
          answer TEXT DEFAULT '',
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) console.error('Table creation error:', err);
      });
    });
  } catch (err) {
    console.error('Database initialization failed:', err);
    process.exit(1); // Exit to allow Railway to restart
  }
}

// Upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const tempPath = req.file.path;
  try {
    // Validate image
    if (!req.file.mimetype.startsWith('image/jpeg')) {
      await fs.unlink(tempPath).catch(() => {});
      return res.status(400).json({ error: 'Only JPEG images are supported' });
    }

    const imgBuffer = await fs.readFile(tempPath);
    if (imgBuffer.length > 5 * 1024 * 1024) {
      await fs.unlink(tempPath).catch(() => {});
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }

    const b64 = imgBuffer.toString('base64');
    if (!b64.startsWith('/9j/')) {
      await fs.unlink(tempPath).catch(() => {});
      return res.status(400).json({ error: 'Invalid JPEG format' });
    }

    // Check Perplexity API key
    if (!process.env.PPLX_API_KEY) {
      await fs.unlink(tempPath).catch(() => {});
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Call Perplexity API
    const prompt = 'Based on the image, generate one relevant question about the content and provide a concise answer to it.';
    let response;
    try {
      response = await pRetry(() => fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PPLX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'sonar-reasoning-pro',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
            ]
          }],
          max_tokens: 200
        })
      }), { retries: 3 });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Perplexity API failed: ${response.status} - ${errorText}`);
      }
    } catch (err) {
      console.error('Perplexity API error:', err);
      await fs.unlink(tempPath).catch(() => {});
      return res.status(500).json({ error: 'Perplexity API error', details: err.message });
    }

    // Parse API response
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || 'No response from API';
    const parts = content.split('Answer: ');
    const question = parts[0]?.replace('Question: ', '')?.trim() || 'What is in the image?';
    const answer = parts[1]?.trim() || content;

    // Store in database
    try {
      await new Promise((resolve, reject) => {
        db.run('INSERT INTO answers (question, answer) VALUES (?, ?)', [question, answer], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      console.error('Database insert error:', err);
      await fs.unlink(tempPath).catch(() => {});
      return res.status(500).json({ error: 'Database error', details: err.message });
    }

    // Clean up and respond
    await fs.unlink(tempPath).catch(() => {});
    res.json({ question, answer });
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Answers endpoint
app.get('/answers', async (req, res) => {
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all('SELECT question, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    res.json(rows.map(row => ({
      question: row.question,
      answer: row.answer,
      timestamp: row.timestamp
    })));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).json({ error: 'Error fetching answers', details: err.message });
  }
});

// Healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// Global error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});