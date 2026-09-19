from fastapi import FastAPI
import secrets
import string
import uuid
from datetime import datetime, timedelta, timezone

app = FastAPI(
    title="CodeBridge API",
    description="Accountless temporary file transfer",
    version="1.0.0"
)


@app.get("/")
def root():
    return {
        "success": True,
        "message": "CodeBridge API is running 🚀"
    }


@app.get("/api/health")
def health():
    return {
        "success": True,
        "message": "Backend is healthy"
    }


# Generate a 6-digit transfer code
def generate_transfer_code():
    return ''.join(
        secrets.choice(string.digits)
        for _ in range(6)
    )


# Create a new transfer
@app.post("/api/transfers")
def create_transfer():

    # Generate unique transfer ID
    transfer_id = str(uuid.uuid4())

    # Generate 6-digit code
    code = generate_transfer_code()

    # Generate secure session token
    session_token = secrets.token_urlsafe(32)

    # Transfer expires after 10 minutes
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=10)

    return {
        "success": True,
        "transfer_id": transfer_id,
        "code": code,
        "expires_in": 600,
        "expires_at": expires_at.isoformat(),
        "session_token": session_token
    }