import os
import sqlite3
import aiohttp
import base64
import json
import logging
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORS
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from datetime import datetime
from tenacity import retry, stop_after_attempt, wait_fixed
import uvicorn

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# Enable CORS for client-side requests
app.add_middleware(
    CORS,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# File system setup
STORAGE_PATH = os.getenv("STORAGE_PATH", "/tmp")
UPLOADS_DIR = Path(STORAGE_PATH) / "uploads"
DB_PATH = Path(STORAGE_PATH) / "answers.db"

# Ensure uploads directory exists
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# Initialize SQLite database
def init_database():
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question TEXT DEFAULT '',
                answer TEXT DEFAULT '',
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()
        logger.info("Connected to SQLite database")
    except sqlite3.Error as e:
        logger.error(f"Database initialization failed: {e}")
        raise SystemExit(1)
    finally:
        conn.close()

init_database()

# Upload endpoint
@app.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    if not file:
        raise HTTPException(status_code=400, detail="No file uploaded")

    # Validate file type
    if not file.content_type.startswith("image/jpeg"):
        raise HTTPException(status_code=400, detail="Only JPEG images are supported")

    # Read and validate file size
    try:
        content = await file.read()
        if len(content) > 5 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Image too large (max 5MB)")
    except Exception as e:
        logger.error(f"Error reading file: {e}")
        raise HTTPException(status_code=500, detail=f"Error reading file: {str(e)}")

    # Validate JPEG format
    b64 = base64.b64encode(content).decode("utf-8")
    if not b64.startswith("/9j/"):
        raise HTTPException(status_code=400, detail="Invalid JPEG format")

    # Check Perplexity API key
    api_key = os.getenv("PPLX_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="API key not configured")

    # Call Perplexity API with retry
    prompt = "Based on the image, generate one relevant question about the content and provide a concise answer to it."
    async def call_perplexity():
        async with aiohttp.ClientSession() as session:
            try:
                async with session.post(
                    "https://api.perplexity.ai/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": "sonar-reasoning-pro",
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                            ]
                        }],
                        "max_tokens": 200,
                    },
                    timeout=10,
                ) as response:
                    if not response.ok:
                        error_text = await response.text()
                        raise HTTPException(status_code=500, detail=f"Perplexity API failed: {response.status} - {error_text}")
                    return await response.json()
            except Exception as e:
                logger.error(f"Perplexity API error: {e}")
                raise

    try:
        data = await retry(stop=stop_after_attempt(3), wait=wait_fixed(2))(call_perplexity)()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Perplexity API error: {str(e)}")

    # Parse API response
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "No response from API")
    parts = content.split("Answer: ")
    question = parts[0].replace("Question: ", "").strip() if len(parts) > 1 else "What is in the image?"
    answer = parts[1].strip() if len(parts) > 1 else content

    # Store in database
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO answers (question, answer) VALUES (?, ?)", (question, answer))
        conn.commit()
    except sqlite3.Error as e:
        logger.error(f"Database insert error: {e}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    finally:
        conn.close()

    return {"question": question, "answer": answer}

# Answers endpoint
@app.get("/answers")
async def get_answers():
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT question, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20")
        rows = cursor.fetchall()
        return [{"question": row[0], "answer": row[1], "timestamp": row[2]} for row in rows]
    except sqlite3.Error as e:
        logger.error(f"Database query error: {e}")
        raise HTTPException(status_code=500, detail=f"Error fetching answers: {str(e)}")
    finally:
        conn.close()

# Healthcheck endpoint
@app.get("/health")
async def health():
    return {"status": "OK"}

# Start server
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8080)))