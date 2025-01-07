import asyncio
import websocket
import os
import json
from dotenv import load_dotenv
from base64 import b64decode
import simpleaudio as sa

load_dotenv()

AZURE_WEBSOCKET_ENDPOINT = os.getenv("AZURE_WEBSOCKET_ENDPOINT")
AZURE_KEY = os.getenv("AZURE_KEY")

url = AZURE_WEBSOCKET_ENDPOINT
headers = ["api-key: " + AZURE_KEY]

print(f"WebSocket Endpoint: {AZURE_WEBSOCKET_ENDPOINT}")
print(f"API Key Provided: {'Yes' if AZURE_KEY else 'No'}")

# Global variables for managing WebSocket communication
ws = None
response_text = ""


def on_open(ws):
    print("Connected to server.")


def on_message(ws, message):
    global response_text
    data = json.loads(message)

    if data["type"] == "response.text":
        # Handle text response
        response_text = data["response"]["text"]
        print("Text Response:", response_text)

    elif data["type"] == "response.audio.delta":
        # Handle streaming audio response
        audio_chunk = b64decode(data["delta"])
        play_audio_chunk(audio_chunk)  # Stream audio playback

    elif data["type"] == "response.audio.done":
        print("Audio streaming complete.")


def on_error(ws, error):
    print("WebSocket error:", error)


def on_close(ws, close_status_code, close_msg):
    print(f"WebSocket closed. Code: {close_status_code}, Message: {close_msg}")


def play_audio_chunk(audio_bytes):
    """Play a chunk of PCM audio data on the laptop."""
    try:
        # Play the raw PCM16 audio data in real-time
        playback = sa.play_buffer(
            audio_bytes, num_channels=1, bytes_per_sample=2, sample_rate=16000
        )
        playback.wait_done()  # Wait for the chunk to finish
    except Exception as e:
        print("Error playing audio chunk:", e)


def ask(question):
    """Send a question to the model and retrieve text and audio responses."""
    global ws
    if not ws:
        print("WebSocket is not connected.")
        return

    # Send user question
    event = {
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": question}],
        },
    }
    ws.send(json.dumps(event))

    # Request response from the model
    event = {
        "type": "response.create",
        "response": {
            "modalities": ["text", "audio"],
            "instructions": "Respond with both text and audio.",
        },
    }
    ws.send(json.dumps(event))


websocket.enableTrace(False)

ws = websocket.WebSocketApp(
    url,
    header=headers,
    on_open=on_open,
    on_message=on_message,
    on_error=on_error,
    on_close=on_close,
)


# Run the WebSocket in a separate thread
async def run_ws():
    ws.run_forever()


# Example usage
if __name__ == "__main__":
    asyncio.run(run_ws())
    while True:
        question = input("What is capital of France? ")
        ask(question)
