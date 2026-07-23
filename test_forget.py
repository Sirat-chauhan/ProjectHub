import os
import requests
from dotenv import load_dotenv

load_dotenv()
neon_url = os.getenv("NEON_AUTH_URL").rstrip('/')

email = "sirat_chauhan@softprodigy.com"

# Try forget-password
res = requests.post(f"{neon_url}/forget-password", json={"email": email, "redirectTo": "http://localhost:8000/?recovery=true"})
print(f"Forget Status: {res.status_code}")
print(f"Forget Response: {res.text}")

# Also try to sign up the user just in case they don't exist
res = requests.post(f"{neon_url}/sign-up/email", json={"email": email, "password": "Password123!", "name": "Sirat"})
print(f"Signup Status: {res.status_code}")
print(f"Signup Response: {res.text}")

