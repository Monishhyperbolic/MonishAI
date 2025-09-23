# Use official Python 3.11 slim as base image
FROM python:3.11-slim

# Set working directory in container
WORKDIR /app

# Install system dependencies (if any needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Make uploads directory
RUN mkdir -p /tmp/uploads

# Expose port (Railway will forward dynamically)
EXPOSE 8080

# Use environment variable PORT or fallback to 8080 inside app code
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
