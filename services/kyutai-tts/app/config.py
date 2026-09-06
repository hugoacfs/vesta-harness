# config.py

import logging
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

import os

# Model parameters. n_q = audio codebooks decoded per frame (quality vs per-step cost),
# temp = sampling temperature, cfg_coef = classifier-free guidance weight (2.0 doubles
# the per-step batch; 1.0 disables guidance and is the fastest). Every generation step
# costs the same, and the first audio frame only appears after the model's initial
# delay of steps, so per-step cost is the time-to-first-audio lever.
DEFAULT_MODEL_PARAMS = {
    "n_q": int(os.environ.get("KYUTAI_N_Q", "32")),
    "temp": float(os.environ.get("KYUTAI_TEMP", "0.6")),
}
CFG_COEF = float(os.environ.get("KYUTAI_CFG_COEF", "2.0"))
