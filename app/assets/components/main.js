import { useState, useRef } from 'react';
import useWebSocket from 'react-use-websocket';

const BUFFER_SIZE = 4800;
const SAMPLE_RATE = 24000;

class Recorder {
  constructor(onDataAvailable) {
    this.onDataAvailable = onDataAvailable;
    this.audioContext = null;
    this.mediaStream = null;
    this.mediaStreamSource = null;
    this.workletNode = null;
  }

  async start(stream) {
    try {
      if (this.audioContext) {
        await this.audioContext.close();
      }

      this.audioContext = new AudioContext({ sampleRate: 24000 });

      await this.audioContext.audioWorklet.addModule(
        './audio-processor-worklet.js'
      );

      this.mediaStream = stream;
      this.mediaStreamSource = this.audioContext.createMediaStreamSource(
        this.mediaStream
      );

      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        'audio-processor-worklet'
      );
      this.workletNode.port.onmessage = (event) => {
        this.onDataAvailable(event.data.buffer);
      };

      this.mediaStreamSource.connect(this.workletNode);
      this.workletNode.connect(this.audioContext.destination);
    } catch (error) {
      console.error('Error starting Recorder:', error);
      this.stop();
    }
  }

  async stop() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.mediaStreamSource = null;
    this.workletNode = null;
  }
}

class Player {
  constructor() {
    this.playbackNode = null;
  }

  async init(sampleRate) {
    const audioContext = new AudioContext({ sampleRate });
    await audioContext.audioWorklet.addModule('audio-playback-worklet.js');

    this.playbackNode = new AudioWorkletNode(
      audioContext,
      'audio-playback-worklet'
    );
    this.playbackNode.connect(audioContext.destination);
  }

  play(buffer) {
    if (this.playbackNode) {
      this.playbackNode.port.postMessage(buffer);
    }
  }

  stop() {
    if (this.playbackNode) {
      this.playbackNode.port.postMessage(null);
    }
  }
}

function useRealTime({
  useDirectAoaiApi,
  aoaiEndpointOverride,
  aoaiApiKeyOverride,
  aoaiModelOverride,
  enableInputAudioTranscription,
  onWebSocketOpen,
  onWebSocketClose,
  onWebSocketError,
  onWebSocketMessage,
  onReceivedResponseDone,
  onReceivedResponseAudioDelta,
  onReceivedResponseAudioTranscriptDelta,
  onReceivedInputAudioBufferSpeechStarted,
  onReceivedExtensionMiddleTierToolResponse,
  onReceivedInputAudioTranscriptionCompleted,
  onReceivedError,
}) {
  const wsEndpoint = useDirectAoaiApi
    ? `${aoaiEndpointOverride}/openai/realtime?api-key=${aoaiApiKeyOverride}&deployment=${aoaiModelOverride}&api-version=2024-10-01-preview`
    : `/realtime`;

  const { sendJsonMessage } = useWebSocket(wsEndpoint, {
    onOpen: () => onWebSocketOpen?.(),
    onClose: () => onWebSocketClose?.(),
    onError: (event) => onWebSocketError?.(event),
    onMessage: (event) => onMessageReceived(event),
    shouldReconnect: () => true,
  });

  const startSession = () => {
    const command = {
      type: 'session.update',
      session: {
        turn_detection: {
          type: 'server_vad',
        },
      },
    };

    if (enableInputAudioTranscription) {
      command.session.input_audio_transcription = {
        model: 'whisper-1',
      };
    }

    sendJsonMessage(command);
  };

  const addUserAudio = (base64Audio) => {
    const command = {
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    };

    sendJsonMessage(command);
  };

  const inputAudioBufferClear = () => {
    const command = {
      type: 'input_audio_buffer.clear',
    };

    sendJsonMessage(command);
  };

  const onMessageReceived = (event) => {
    onWebSocketMessage?.(event);

    let message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      console.error('Failed to parse JSON message:', e);
      throw e;
    }

    switch (message.type) {
      case 'response.done':
        onReceivedResponseDone?.(message);
        break;
      case 'response.audio.delta':
        onReceivedResponseAudioDelta?.(message);
        break;
      case 'response.audio_transcript.delta':
        onReceivedResponseAudioTranscriptDelta?.(message);
        break;
      case 'input_audio_buffer.speech_started':
        onReceivedInputAudioBufferSpeechStarted?.(message);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        onReceivedInputAudioTranscriptionCompleted?.(message);
        break;
      case 'extension.middle_tier_tool_response':
        onReceivedExtensionMiddleTierToolResponse?.(message);
        break;
      case 'error':
        onReceivedError?.(message);
        break;
      default:
        console.warn('Unhandled message type:', message.type);
    }
  };

  return { startSession, addUserAudio, inputAudioBufferClear };
}

function useAudioRecorder({ onAudioRecorded }) {
  const audioRecorder = useRef(null);

  let buffer = new Uint8Array();

  const appendToBuffer = (newData) => {
    const newBuffer = new Uint8Array(buffer.length + newData.length);
    newBuffer.set(buffer);
    newBuffer.set(newData, buffer.length);
    buffer = newBuffer;
  };

  const handleAudioData = (data) => {
    const uint8Array = new Uint8Array(data);
    appendToBuffer(uint8Array);

    if (buffer.length >= BUFFER_SIZE) {
      const toSend = new Uint8Array(buffer.slice(0, BUFFER_SIZE));
      buffer = new Uint8Array(buffer.slice(BUFFER_SIZE));

      const regularArray = String.fromCharCode(...toSend);
      const base64 = btoa(regularArray);

      onAudioRecorded(base64);
    }
  };

  const start = async () => {
    if (!audioRecorder.current) {
      audioRecorder.current = new Recorder(handleAudioData);
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioRecorder.current.start(stream);
  };

  const stop = async () => {
    await audioRecorder.current?.stop();
  };

  return { start, stop };
}

function useAudioPlayer() {
  const audioPlayer = useRef(null);

  const reset = () => {
    audioPlayer.current = new Player();
    audioPlayer.current.init(SAMPLE_RATE);
  };

  const play = (base64Audio) => {
    const binary = atob(base64Audio);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const pcmData = new Int16Array(bytes.buffer);

    audioPlayer.current?.play(pcmData);
  };

  const stop = () => {
    audioPlayer.current?.stop();
  };

  return { reset, play, stop };
}

function StatusMessage({ isRecording }) {
  const statusMessages = {
    notRecordingMessage: 'Ask anything',
    conversationInProgress: 'Conversation in progress',
  };

  if (!isRecording) {
    return <p>{statusMessages.notRecordingMessage}</p>;
  }

  return (
    <div>
      <p>{statusMessages.conversationInProgress}</p>
    </div>
  );
}

export function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);

  const { startSession, addUserAudio, inputAudioBufferClear } = useRealTime({
    onWebSocketOpen: () => console.log('WebSocket connection opened'),
    onWebSocketClose: () => console.log('WebSocket connection closed'),
    onWebSocketError: (event) => console.error('WebSocket error:', event),
    onReceivedError: (message) => console.error('error', message),
    onReceivedResponseAudioDelta: (message) => {
      isRecording && playAudio(message.delta);
    },
    onReceivedInputAudioBufferSpeechStarted: () => {
      stopAudioPlayer();
    },
    onReceivedExtensionMiddleTierToolResponse: (message) => {
      const result = JSON.parse(message.tool_result);

      const files = result.sources.map((x) => ({
        id: x.chunk_id,
        name: x.title,
        content: x.chunk,
      }));
    },
  });

  const {
    reset: resetAudioPlayer,
    play: playAudio,
    stop: stopAudioPlayer,
  } = useAudioPlayer();
  const { start: startAudioRecording, stop: stopAudioRecording } =
    useAudioRecorder({
      onAudioRecorded: addUserAudio,
    });

  const onToggleListening = async () => {
    if (!isRecording) {
      startSession();
      await startAudioRecording();
      resetAudioPlayer();

      setIsRecording(true);
    } else {
      await stopAudioRecording();
      stopAudioPlayer();
      inputAudioBufferClear();

      setIsRecording(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <button
        onClick={onToggleListening}
        style={{
          height: '3rem',
          width: '15rem',
          backgroundColor: isRecording ? '#dc2626' : '#7c3aed',
          color: '#ffffff',
          borderRadius: '0.375rem',
          textAlign: 'center',
          lineHeight: '3rem',
          cursor: 'pointer',
          transition: 'background-color 0.2s ease',
        }}
        onMouseOver={(e) => {
          e.target.style.backgroundColor = isRecording ? '#b91c1c' : '#6d28d9';
        }}
        onMouseOut={(e) => {
          e.target.style.backgroundColor = isRecording ? '#dc2626' : '#7c3aed';
        }}
      >
        {isRecording ? <>{'Stop recording'}</> : <>{'Start recording'}</>}
      </button>
      <StatusMessage isRecording={isRecording} />
    </div>
  );
}
