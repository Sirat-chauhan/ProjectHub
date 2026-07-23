import os
import requests
from dotenv import load_dotenv

load_dotenv()
neon_url = os.getenv("NEON_AUTH_URL").rstrip('/')

email = "sirat_chauhan@softprodigy.com"

# Try to sign in with a dummy password to see if the user exists
res = requests.post(f"{neon_url}/sign-in/email", json={"email": email, "password": "WrongPassword123!"})
print(f"Status: {res.status_code}")
print(f"Response: {res.text}")
