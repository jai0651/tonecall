export type AgentConfig = {
  number: string;
  name: string;
  prompt: string;
  capabilities: string[];
  /** OpenAI tts-1 voice id: alloy | echo | fable | onyx | nova | shimmer. */
  voice?: string;
  /**
   * Logical Plivo-account identifier (`'1'` or `'2'`). The plivo wrapper
   * uses this to pick the right auth_id/auth_token when making REST calls
   * on behalf of THIS agent's leg.
   */
  accountId?: '1' | '2';
};

/**
 * Plivo Audio Streaming WebSocket events.
 * Wire format documented at:
 *   https://www.plivo.com/docs/voice-agents/audio-streaming/integration-guides/plivo-stream-sdk
 *
 * Every inbound message carries a literal top-level `event` field. The
 * `extra_headers` field is included by Plivo on most events; we never read it
 * but we keep it on the type so structural checks don't fail.
 */
export type PlivoStreamEvent =
  | {
      event: 'start';
      sequenceNumber?: number;
      start: {
        callId: string;
        streamId: string;
        accountId?: string;
        tracks?: string[];
        mediaFormat: { encoding: string; sampleRate: number };
      };
      extra_headers?: string;
    }
  | {
      event: 'media';
      sequenceNumber?: number;
      streamId?: string;
      media: {
        track?: string;
        timestamp?: string;
        chunk?: number;
        payload: string; // base64
      };
      extra_headers?: string;
    }
  | {
      event: 'dtmf';
      sequenceNumber?: number;
      streamId?: string;
      dtmf: { track?: string; digit: string; timestamp?: string };
      extra_headers?: string;
    }
  | {
      event: 'stop';
      sequenceNumber?: number;
      streamId?: string;
      stop?: { callId?: string; reason?: string };
    }
  | { event: 'playedStream'; sequenceNumber?: number; streamId?: string; name: string }
  | { event: 'clearedAudio'; sequenceNumber?: number; streamId?: string };

export type AgentJsonMessage =
  | { type: 'hello'; from: string; capabilities: string[] }
  | { type: 'intent'; name: string; slots: Record<string, unknown> }
  | { type: 'reply'; text: string; slots?: Record<string, unknown>; done?: boolean }
  | { type: 'confirm'; orderId?: string; etaMinutes?: number; totalUsd?: number }
  | { type: 'commit'; paymentToken?: string }
  | { type: 'request_voice_mode'; reason: string }
  | { type: 'bye' };

export type PhaseName = 'voice_intro' | 'data_exchange' | 'voice_goodbye' | 'human_voice';

export type DemoEvent =
  | { kind: 'call.triggered'; callerNumber: string; calleeNumber: string; ts: number }
  | { kind: 'call.mode'; callUuid: string; mode: 'agent_to_agent' | 'human_to_agent'; ts: number }
  | { kind: 'handshake.started'; callUuid: string; ts: number }
  | { kind: 'handshake.peer_detected'; callUuid: string; peerNonce: string; ts: number }
  | { kind: 'handshake.paired'; callUuid: string; sessionId: string; ts: number }
  | { kind: 'handshake.timeout'; callUuid: string; ts: number }
  | {
      kind: 'pairing.summary';
      callUuid: string;
      sessionId: string;
      path: 'in_band_nonce';
      ts: number;
    }
  | { kind: 'agent.message'; from: string; payload: AgentJsonMessage; ts: number }
  | { kind: 'voice.transcript'; speaker: string; text: string; ts: number }
  | { kind: 'phase.started'; phase: PhaseName; ts: number }
  | {
      kind: 'phase.ended';
      phase: PhaseName;
      durationMs: number;
      turns: number;
      ts: number;
    }
  | {
      kind: 'demo.summary';
      voiceMs: number;
      dataMs: number;
      voiceTurns: number;
      dataTurns: number;
      voiceBaselineMs: number;
      latencySavedMs: number;
      costUsdActual: number;
      costUsdBaseline: number;
      costSavedUsd: number;
      ts: number;
    }
  | { kind: 'call.ended'; callUuid: string; durationMs: number; ts: number };

export type ConnectionState = 'HANDSHAKING' | 'PAIRED' | 'VOICE' | 'ENDED';
