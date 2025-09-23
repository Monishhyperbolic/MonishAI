import os
import sqlite3
import aiohttp
import base64
import logging
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from tenacity import retry, stop_after_attempt, wait_fixed
import uvicorn

# --- Configuration ---
# Configure logging to provide insights into the application's execution.
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI()

# --- Static Files and CORS ---
# Determine the directory for static files (HTML, CSS, JS)
STATIC_DIR = Path(__file__).parent / "static"
# Create the static directory if it doesn't exist to prevent errors on startup
STATIC_DIR.mkdir(exist_ok=True) 
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Configure Cross-Origin Resource Sharing (CORS) to allow browser requests
# from any origin. This is convenient for development but should be restricted
# in a production environment for security.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # WARNING: Adjust for production environments
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Storage and Database Setup ---
# Define paths for storing uploaded files and the SQLite database.
# Use environment variables for flexibility, with sensible defaults.
STORAGE_PATH = Path(os.getenv("STORAGE_PATH", "/tmp/image_analyzer"))
UPLOADS_DIR = STORAGE_PATH / "uploads"
DB_PATH = STORAGE_PATH / "answers.db"

# Create storage directories if they don't exist.
STORAGE_PATH.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

def init_database():
    """Initializes the SQLite database and creates the 'answers' table if not present."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            # Create a table to store questions, answers, and timestamps.
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS answers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()
            logger.info(f"Database initialized successfully at {DB_PATH}")
    except sqlite3.Error as e:
        logger.error(f"FATAL: Failed to initialize database: {e}")
        # Exit if the database cannot be set up, as the app is not functional.
        raise SystemExit(1)

# Initialize the database when the application starts.
init_database()

# --- HTML Page Routes ---

@app.get("/")
async def index():
    """Serves the main landing page."""
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/camera")
async def camera():
    """Serves the camera/upload page."""
    return FileResponse(STATIC_DIR / "camera.html")

@app.get("/answers_page")
async def answers_page():
    """Serves the page that displays past answers."""
    return FileResponse(STATIC_DIR / "answers.html")

# --- API Endpoints ---

@app.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    """
    Handles image uploads, sends them to the Perplexity API for analysis,
    and stores the resulting question and answer in the database.
    """
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="No file uploaded.")

    # Validate file type to ensure it's a JPEG image.
    if not file.content_type or not file.content_type.startswith("image/jpeg"):
        raise HTTPException(status_code=400, detail="Only JPEG images are supported.")

    try:
        content = await file.read()
        # Validate file size to prevent excessive memory usage.
        if len(content) > 5 * 1024 * 1024:  # 5 MB limit
            raise HTTPException(status_code=413, detail="Image is too large (max 5MB).")
    except Exception as e:
        logger.error(f"Error reading uploaded file: {e}")
        raise HTTPException(status_code=500, detail=f"An error occurred while reading the file: {e}")

    # Encode the image content to Base64.
    b64_image = base64.b64encode(content).decode("utf-8")

    api_key = os.getenv("PPLX_API_KEY")
    if not api_key:
        logger.error("PPLX_API_KEY environment variable not set.")
        raise HTTPException(status_code=500, detail="API key is not configured on the server.")

    # This detailed prompt guides the LLM to return the data in a predictable format,
    # making the response easier to parse reliably.
    prompt = """Analyze the provided image and generate a single, relevant question about its content, followed by a concise answer.

Please format your response *exactly* as follows, with no additional text or explanations:
Question: [Your question here]
Answer: [Your answer here]"""

    @retry(stop=stop_after_attempt(3), wait=wait_fixed(2))
    async def call_perplexity_api():
        """Calls the Perplexity API with retry logic."""
        logger.info("Calling Perplexity API...")
        # *** FIX: Using a current, powerful model with vision capabilities. ***
        # 'llama-3-sonar-large-32k-online' is a strong choice for this task.
        model_name = "llama-3-sonar-large-32k-online"
        
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model_name,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"},
                        },
                    ],
                }
            ],
            "max_tokens": 300,
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.perplexity.ai/chat/completions",
                headers=headers,
                json=payload,
                timeout=30,
            ) as response:
                if not response.ok:
                    error_text = await response.text()
                    logger.error(f"Perplexity API error: {response.status} - {error_text}")
                    # Raise a generic error to avoid exposing internal details to the client.
                    raise HTTPException(status_code=502, detail="Failed to get a response from the AI service.")
                logger.info("Perplexity API call succeeded.")
                return await response.json()

    try:
        data = await call_perplexity_api()
        api_content = data.get("choices", [{}])[0].get("message", {}).get("content")
        if not api_content:
            raise HTTPException(status_code=500, detail="AI service returned an empty response.")
    except Exception as e:
        logger.error(f"Perplexity API call failed after retries: {e}")
        # Check if it's an HTTPException and re-raise, otherwise wrap it.
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=f"An error occurred while contacting the AI service.")

    # --- Parse the API Response ---
    # This logic is brittle and depends on the model following the prompt format.
    question, answer = "Could not determine the question.", "Could not determine the answer."
    try:
        if "Question:" in api_content and "Answer:" in api_content:
            question_part, answer_part = api_content.split("Answer:", 1)
            question = question_part.replace("Question:", "").strip()
            answer = answer_part.strip()
        else:
            # Fallback if the model doesn't follow the format.
            question = "What is in the image?"
            answer = api_content.strip()
    except ValueError:
         logger.warning(f"Could not parse API response: {api_content}")
         answer = api_content.strip() # Assign the full content as the answer

    # --- Store in Database ---
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO answers (question, answer) VALUES (?, ?)",
                (question, answer),
            )
            conn.commit()
            logger.info("Successfully stored question and answer in the database.")
    except sqlite3.Error as e:
        logger.error(f"Database insert error: {e}")
        raise HTTPException(status_code=500, detail="Failed to store the result due to a database error.")

    return {"question": question, "answer": answer}

@app.get("/answers")
async def get_answers():
    """Retrieves the 20 most recent question/answer pairs from the database."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            # Use a row factory for easier dictionary conversion
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                "SELECT question, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 20"
            )
            rows = cursor.fetchall()
            # Convert row objects to dictionaries
            return [dict(row) for row in rows]
    except sqlite3.Error as e:
        logger.error(f"Database query error: {e}")
        raise HTTPException(status_code=500, detail=f"An error occurred while fetching answers.")

@app.get("/health")
async def health_check():
    """A simple endpoint to confirm that the service is running."""
    return {"status": "ok"}

# --- Application Runner ---
if __name__ == "__main__":
    # Get port from environment variable, with a default.
    port_str = os.getenv("PORT", "8080")
    try:
        port = int(port_str)
    except ValueError:
        logger.warning(f"Invalid PORT value '{port_str}', defaulting to 8080.")
        port = 8080

    logger.info(f"Starting server on http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
