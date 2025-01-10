import asyncio
import websockets
import json
import os
from dotenv import load_dotenv

import pyaudio
import numpy as np
import base64
import time

load_dotenv()

url = os.getenv("AZURE_WEBSOCKET_ENDPOINT")
key = os.getenv("AZURE_KEY")


async def connect():
    async with websockets.connect(
        url,
        additional_headers={"api-key": key},
    ) as websocket:
        print("Connected to server.")

        # Create tasks for sending and receiving messages
        receive_task = asyncio.create_task(receive_messages(websocket))
        record_task = asyncio.create_task(record_audio(websocket))

        # Wait for both tasks to complete
        await asyncio.gather(receive_task, record_task)


async def receive_messages(websocket):
    p = pyaudio.PyAudio()
    stream = p.open(format=pyaudio.paInt16, channels=1, rate=24000, output=True)

    try:
        while True:
            message = await websocket.recv()
            message_data = json.loads(message)

            if message_data.get("type") == "response.done":
                print("Response Done:", message_data)
            elif message_data.get("type") == "response.audio.delta":
                delta = base64.b64decode(message_data.get("delta"))
                stream.write(delta)
    except websockets.exceptions.ConnectionClosed as e:
        print(f"Connection closed: {e}")
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()


async def record_audio(websocket):
    p = pyaudio.PyAudio()
    sample_rate = 24000
    chunk_size = 2400
    stream = p.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=sample_rate,
        input=True,
        frames_per_buffer=chunk_size,
    )

    try:
        session_config = {
            "type": "session.update",
            "session": {
                "turn_detection": {"type": "server_vad", "threshold": 0.5},
                "input_audio_transcription": {"model": "whisper-1"},
            },
        }
        await websocket.send(json.dumps(session_config))

        start_time = time.time()
        record_seconds = 500

        while time.time() - start_time < record_seconds:
            data = stream.read(chunk_size, exception_on_overflow=False)
            base64_audio = base64.b64encode(data).decode("utf-8")
            await websocket.send(
                json.dumps({"type": "input_audio_buffer.append", "audio": base64_audio})
            )
            await asyncio.sleep(0.01)  # Allow minimal delay to prevent overflow
    except websockets.exceptions.ConnectionClosed as e:
        print(f"Connection closed during recording: {e}")
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()


if __name__ == "__main__":
    asyncio.run(connect())
