import os
import requests
from dotenv import load_dotenv

load_dotenv()
neon_url = os.getenv("NEON_AUTH_URL")
if neon_url:
    neon_url = neon_url.rstrip('/')
print("Neon URL:", neon_url)

email = "sirat_chauhan@softprodigy.com"

# Try to request reset
res = requests.post(f"{neon_url}/request-password-reset", json={"email": email, "redirectTo": "http://localhost:8000/?recovery=true"})
print(f"Status: {res.status_code}")
print(f"Response: {res.text}")
