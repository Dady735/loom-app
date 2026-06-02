"""
Loom – WSGI entry point for PythonAnywhere deployment.
PythonAnywhere uses this file to serve the Flask app.
"""

import os
import sys

# Add the project directory to Python path
project_dir = os.path.dirname(os.path.abspath(__file__))
if project_dir not in sys.path:
    sys.path.insert(0, project_dir)

# Load environment variables from .env
from dotenv import load_dotenv
env_path = os.path.join(project_dir, ".env")
load_dotenv(env_path, override=True)

# Import and create the Flask app
from app import app as application

# PythonAnywhere expects the WSGI callable to be named 'application'
# Flask's app object is already a WSGI callable, so this works directly.
