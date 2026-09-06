# config.py

import logging
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Default model parameters
DEFAULT_MODEL_PARAMS = {
    "n_q": 32,
    "temp": 0.6,
}
