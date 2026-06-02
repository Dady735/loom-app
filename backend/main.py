"""
Loom – Replit Entry Point
Runs the Flask app on the port specified by Replit (PORT env var).
"""

import os
import sys

# Add project directory to Python path
project_dir = os.path.dirname(os.path.abspath(__file__))
if project_dir not in sys.path:
    sys.path.insert(0, project_dir)

# Load environment variables from .env (if present)
from dotenv import load_dotenv
load_dotenv(os.path.join(project_dir, ".env"), override=True)

# Import and run the Flask app
from app import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
