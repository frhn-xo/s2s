import asyncio
import json
import logging
from enum import Enum
from typing import Any, Callable, Optional

import aiohttp
from aiohttp import web
from azure.core.credentials import AzureKeyCredential
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

logger = logging.getLogger("voicerag")


class ToolResultDirection(Enum):
    TO_SERVER = 1
    TO_CLIENT = 2


class ToolResult:
    text: str
    destination: ToolResultDirection

    def __init__(self, text: str, destination: ToolResultDirection):
        self.text = text
        self.destination = destination

    def to_text(self) -> str:
        if self.text is None:
            return ""
        return self.text if type(self.text) == str else json.dumps(self.text)


class Tool:
    target: Callable[..., ToolResult]
    schema: Any

    def __init__(self, target: Any, schema: Any):
        self.target = target
        self.schema = schema


class RTToolCall:
    tool_call_id: str
    previous_id: str

    def __init__(self, tool_call_id: str, previous_id: str):
        self.tool_call_id = tool_call_id
        self.previous_id = previous_id


class RTMiddleTier:
    endpoint: str
    deployment: str
    key: Optional[str] = None

    # Tools are server-side only for now, though the case could be made for client-side tools
    # in addition to server-side tools that are invisible to the client
    tools: dict[str, Tool] = {}

    # Server-enforced configuration, if set, these will override the client's configuration
    # Typically at least the model name and system message will be set by the server
    model: Optional[str] = None
    system_message: Optional[str] = None
    voice_choice: Optional[str] = "shimmer"
    api_version: str = "2024-10-01-preview"
    _tools_pending = {}
    _token_provider = None

    def __init__(
        self,
        endpoint: str,
        deployment: str,
        credentials: AzureKeyCredential | DefaultAzureCredential,
        voice_choice: Optional[str] = None,
    ):
        self.endpoint = endpoint
        self.deployment = deployment
        self.voice_choice = (
            voice_choice if voice_choice is not None else RTMiddleTier.voice_choice
        )
        if voice_choice is not None:
            logger.info("Realtime voice choice set to %s", voice_choice)
        if isinstance(credentials, AzureKeyCredential):
            self.key = credentials.key
        else:
            self._token_provider = get_bearer_token_provider(
                credentials, "https://cognitiveservices.azure.com/.default"
            )
            self._token_provider()  # Warm up during startup so we have a token cached when the first request arrives

    async def _process_message_to_client(
        self,
        msg: str,
        client_ws: web.WebSocketResponse,
        server_ws: web.WebSocketResponse,
    ) -> Optional[str]:
        message = json.loads(msg.data)
        # print("\nfrom server", message["type"])

        updated_message = msg.data
        if message is not None:
            match message["type"]:
                case "session.created":
                    session = message["session"]
                    session["instructions"] = ""
                    session["tools"] = []
                    session["voice"] = self.voice_choice
                    session["tool_choice"] = "none"
                    session["max_response_output_tokens"] = None
                    updated_message = json.dumps(message)

                case "response.output_item.added":
                    if "item" in message and message["item"]["type"] == "function_call":
                        updated_message = None

                case "conversation.item.created":
                    if "item" in message and message["item"]["type"] == "function_call":
                        item = message["item"]
                        if item["call_id"] not in self._tools_pending:
                            self._tools_pending[item["call_id"]] = RTToolCall(
                                item["call_id"], message["previous_item_id"]
                            )
                        updated_message = None
                    elif (
                        "item" in message
                        and message["item"]["type"] == "function_call_output"
                    ):
                        updated_message = None

                case "response.function_call_arguments.delta":
                    updated_message = None

                case "response.function_call_arguments.done":
                    updated_message = None

                case "response.audio_transcript.done":
                    transcript = message["transcript"]
                    print("\n\noutput transcript:", transcript)

                    if "item" in message and message["item"]["type"] == "function_call":
                        item = message["item"]
                        tool_call = self._tools_pending[message["item"]["call_id"]]
                        tool = self.tools[item["name"]]
                        args = item["arguments"]
                        result = await tool.target(json.loads(args))
                        await server_ws.send_json(
                            {
                                "type": "conversation.item.create",
                                "item": {
                                    "type": "function_call_output",
                                    "call_id": item["call_id"],
                                    "output": (
                                        result.to_text()
                                        if result.destination
                                        == ToolResultDirection.TO_SERVER
                                        else ""
                                    ),
                                },
                            }
                        )
                        if result.destination == ToolResultDirection.TO_CLIENT:
                            # TODO: this will break clients that don't know about this extra message, rewrite
                            # this to be a regular text message with a special marker of some sort
                            await client_ws.send_json(
                                {
                                    "type": "extension.middle_tier_tool_response",
                                    "previous_item_id": tool_call.previous_id,
                                    "tool_name": item["name"],
                                    "tool_result": result.to_text(),
                                }
                            )
                        updated_message = None

                case "response.done":
                    if len(self._tools_pending) > 0:
                        self._tools_pending.clear()  # Any chance tool calls could be interleaved across different outstanding responses?
                        await server_ws.send_json({"type": "response.create"})
                    if "response" in message:
                        replace = False
                        for i, output in enumerate(
                            reversed(message["response"]["output"])
                        ):
                            if output["type"] == "function_call":
                                message["response"]["output"].pop(i)
                                replace = True
                        if replace:
                            updated_message = json.dumps(message)

                case "conversation.item.input_audio_transcription.completed":
                    transcript = message["transcript"]
                    print("\n\ninput transcript:", transcript)

        return updated_message

    async def _process_message_to_server(
        self, msg: str, ws: web.WebSocketResponse
    ) -> Optional[str]:
        message = json.loads(msg.data)
        # print("\n from client", message["type"])

        updated_message = msg.data
        if message is not None:
            match message["type"]:
                case "session.update":
                    session = {}
                    session["modalities"] = ["audio", "text"]
                    session["instructions"] = self.system_message
                    session["voice"] = self.voice_choice
                    session["input_audio_format"] = "pcm16"
                    session["output_audio_format"] = "pcm16"
                    session["input_audio_transcription"] = {"model": "whisper-1"}
                    session["turn_detection"] = {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 200,
                    }
                    session["temperature"] = 0.8
                    session["max_response_output_tokens"] = "inf"
                    session["tools"] = []
                    message["session"] = session
                    updated_message = json.dumps(message)

        return updated_message

    async def _forward_messages(self, ws: web.WebSocketResponse, msg):
        async with aiohttp.ClientSession(base_url=self.endpoint) as session:
            params = {"api-version": self.api_version, "deployment": self.deployment}
            headers = {}
            if "x-ms-client-request-id" in ws.headers:
                headers["x-ms-client-request-id"] = ws.headers["x-ms-client-request-id"]
            if self.key is not None:
                headers = {"api-key": self.key}
            else:
                headers = {
                    "Authorization": f"Bearer {self._token_provider()}"
                }  # NOTE: no async version of token provider, maybe refresh token on a timer?
            async with session.ws_connect(
                "/openai/realtime", headers=headers, params=params
            ) as target_ws:

                async def create_and_update_session(msg):
                    new_msg = await self._process_message_to_server(msg, ws)
                    if new_msg is not None:
                        await target_ws.send_str(new_msg)

                async def from_client_to_server():
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            new_msg = await self._process_message_to_server(msg, ws)
                            if new_msg is not None:
                                await target_ws.send_str(new_msg)
                        else:
                            print("\nError: unexpected message type:", msg.type)

                    # Means it is gracefully closed by the client then time to close the target_ws
                    if target_ws:
                        print("\nClosing OpenAI's realtime socket connection.")
                        await target_ws.close()

                async def from_server_to_client():
                    async for msg in target_ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            new_msg = await self._process_message_to_client(
                                msg, ws, target_ws
                            )
                            if new_msg is not None:
                                await ws.send_str(new_msg)
                        else:
                            print("\nError: unexpected message type:", msg.type)

                try:
                    await create_and_update_session(msg)
                    await asyncio.gather(
                        from_client_to_server(), from_server_to_client()
                    )
                except ConnectionResetError:
                    # Ignore the errors resulting from the client disconnecting the socket
                    pass

    async def _websocket_handler(self, request: web.Request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                if msg.data == "ping":
                    await ws.send_str("pong")
                else:
                    await self._forward_messages(ws, msg)
            elif msg.type == aiohttp.WSMsgType.ERROR:
                logger.error("ws connection closed with exception %s" % ws.exception())
        return ws

    def attach_to_app(self, app, path):
        app.router.add_get(path, self._websocket_handler)
