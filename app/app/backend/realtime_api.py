import json
import base64
import websocket
import pyaudio
import os
from dotenv import load_dotenv

load_dotenv()

AUDIO_SAMPLE_RATE = 24000

url = os.getenv("AZURE_WEBSOCKET_ENDPOINT")
headers = {"api-key": os.getenv("AZURE_KEY")}

p = pyaudio.PyAudio()

stream = p.open(format=pyaudio.paInt16, channels=1, rate=AUDIO_SAMPLE_RATE, output=True)


def send_text_message(ws, text_message):
    print("Sending text message:", text_message)
    ws.send(
        json.dumps(
            {
                "type": "response.create",
                "response": {
                    "modalities": ["text", "audio"],
                    "instructions": text_message,
                },
            }
        )
    )


def on_message(ws, message):
    message_data = json.loads(message)

    if message_data.get("type") == "response.text.delta":
        print(message_data["delta"])
    elif message_data.get("type") == "response.audio.delta":
        audio_data = base64.b64decode(message_data["delta"])
        play_audio(audio_data)
    elif message_data.get("type") == "response.text.done":
        print("Text response done")
    else:
        print(f"Received message of unknown type: {message_data}")


def on_error(ws, error):
    print("Error:", error)


def on_close(ws, close_status_code, close_msg):
    print("Connection closed")


def on_open(ws):
    print("Connection opened. Sending initial data...")

    ws.send(
        json.dumps(
            {
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                },
            }
        )
    )

    send_text_message(ws, "Tell me about AI.")


def play_audio(audio_data):
    stream.write(audio_data)


def start_websocket():
    ws = websocket.WebSocketApp(
        url,
        header=headers,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    ws.run_forever()


if __name__ == "__main__":
    start_websocket()
