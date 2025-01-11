import { useState, useRef } from 'react';
import useWebSocket from 'react-use-websocket';

const SAMPLE_RATE = 24000;
const BUFFER_SIZE = 4800;

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

      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

      const processorCode = `
                const MIN_INT16 = -0x8000;
                const MAX_INT16 = 0x7fff;

                class PCMAudioProcessor extends AudioWorkletProcessor {
                    constructor() {
                        super();
                    }

                    process(inputs, outputs, parameters) {
                        const input = inputs[0];
                        if (input.length > 0) {
                            const float32Buffer = input[0];
                            const int16Buffer = this.float32ToInt16(float32Buffer);
                            this.port.postMessage(int16Buffer);
                        }
                        return true;
                    }

                    float32ToInt16(float32Array) {
                        const int16Array = new Int16Array(float32Array.length);
                        for (let i = 0; i < float32Array.length; i++) {
                            let val = Math.floor(float32Array[i] * MAX_INT16);
                            val = Math.max(MIN_INT16, Math.min(MAX_INT16, val));
                            int16Array[i] = val;
                        }
                        return int16Array;
                    }
                }

                registerProcessor("audio-processor-worklet", PCMAudioProcessor);
            `;
      const processorBlob = new Blob([processorCode], {
        type: 'application/javascript',
      });
      const processorUrl = URL.createObjectURL(processorBlob);
      await this.audioContext.audioWorklet.addModule(processorUrl);

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
    const playbackCode = `
            class AudioPlaybackWorklet extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.port.onmessage = this.handleMessage.bind(this);
                    this.buffer = [];
                }

                handleMessage(event) {
                    if (event.data === null) {
                        this.buffer = [];
                        return;
                    }
                    this.buffer.push(...event.data);
                }

                process(inputs, outputs, parameters) {
                    const output = outputs[0];
                    const channel = output[0];

                    if (this.buffer.length > channel.length) {
                        const toProcess = this.buffer.slice(0, channel.length);
                        this.buffer = this.buffer.slice(channel.length);
                        channel.set(toProcess.map(v => v / 32768));
                    } else {
                        channel.set(this.buffer.map(v => v / 32768));
                        this.buffer = [];
                    }

                    return true;
                }
            }

            registerProcessor("audio-playback-worklet", AudioPlaybackWorklet);
        `;
    const playbackBlob = new Blob([playbackCode], {
      type: 'application/javascript',
    });
    const playbackUrl = URL.createObjectURL(playbackBlob);
    await audioContext.audioWorklet.addModule(playbackUrl);

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
    if (audioRecorder.current) {
      await audioRecorder.current.stop();
    }
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

    if (audioPlayer.current) {
      audioPlayer.current.play(pcmData);
    }
  };

  const stop = () => {
    if (audioPlayer.current) {
      audioPlayer.current.stop();
    }
  };

  return { reset, play, stop };
}

function useRealTime({
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
  const wsEndpoint = 'ws://localhost:8765/realtime';

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
    }
  };

  return { startSession, addUserAudio, inputAudioBufferClear };
}

export function S2S() {
  const [isRecording, setIsRecording] = useState(false);

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
      console.log(message);
    },
  });

  const {
    reset: resetAudioPlayer,
    play: playAudio,
    stop: stopAudioPlayer,
  } = useAudioPlayer();
  const { start: startAudioRecording, stop: stopAudioRecording } =
    useAudioRecorder({ onAudioRecorded: addUserAudio });

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
    <button
      onClick={onToggleListening}
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '3rem',
        width: '10rem',
        backgroundColor: isRecording ? '#dc2626' : '#6b46c1',
        cursor: 'pointer',
      }}
      onMouseOver={(e) => {
        e.currentTarget.style.backgroundColor = isRecording
          ? '#b91c1c'
          : '#553c9a';
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.backgroundColor = isRecording
          ? '#dc2626'
          : '#6b46c1';
      }}
    >
      {isRecording ? <>stop conversation</> : <>start conversation</>}
    </button>
  );
}

// -------------------

// import React from 'react';

// export function S2S() {
//   return (
//     <div>
//       <h1>Speech-to-Speech</h1>
//     </div>
//   );
// }
