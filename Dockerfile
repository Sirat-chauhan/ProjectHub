FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Copy requirements file first to leverage Docker cache
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir --upgrade -r requirements.txt

# Copy the rest of the application code
COPY . .

# Command to run the FastAPI application
# The PORT environment variable can be set dynamically by the hosting platform (defaults to 8000)
CMD uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}
