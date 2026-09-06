# app/utils.py

from io import BytesIO
from pydub import AudioSegment
from fastapi import HTTPException
from config import logger

def convert_audio_format(audio_bytes: bytes, target_format: str) -> bytes:
    """
    Convert audio bytes from WAV format to the target format using pydub.

    Args:
        audio_bytes: The audio data in WAV format
        target_format: The target audio format (e.g., 'mp3', 'flac', 'ogg')

    Returns:
        The converted audio bytes
    """
    try:
        # Create a BytesIO object for the input audio
        audio_file = BytesIO(audio_bytes)

        # Read the WAV audio using pydub
        audio = AudioSegment.from_wav(audio_file)

        # Convert to the target format
        output_file = BytesIO()
        if target_format.lower() == 'mp3':
            audio.export(output_file, format='mp3')
        elif target_format.lower() == 'flac':
            audio.export(output_file, format='flac')
        elif target_format.lower() == 'ogg':
            audio.export(output_file, format='ogg')
        else:
            # Default to WAV if format is not supported
            audio.export(output_file, format='wav')

        output_file.seek(0)
        return output_file.read()
    except Exception as e:
        logger.error(f"Error converting audio format: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to convert audio format: {str(e)}")
