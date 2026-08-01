/**
 * LLM wrapper — OpenAI Chat Completions.
 *
 * Two surfaces:
 *   - respondJson : structured I/O for agent-to-agent paired mode
 *                   (uses `response_format: json_object` to force valid JSON)
 *   - respondText : plain text for voice fallback (after STT)
 *
 * Stub variant returns plausible canned replies so the rest of the pipeline
 * runs without an API key.
 */

import type { AgentJsonMessage } from '@/types';
import { getOpenAI } from './openaiClient';

const USE_STUBS = (process.env.USE_STUBS ?? 'true') === 'true';
const MODEL = process.env.OPENAI_LLM_MODEL ?? 'gpt-4o-mini';

export type VoiceTurn = {
  speaker: string;
  text: string;
};

export type VoiceTurnResult = {
  speak: string;
  wantsToSwitch: boolean;
  reason?: string;
};

export interface LLM {
  respondJson(args: {
    systemPrompt: string;
    history: AgentJsonMessage[];
    peerMessage: AgentJsonMessage;
  }): Promise<AgentJsonMessage>;

  respondText(args: {
    systemPrompt: string;
    history: { role: 'user' | 'assistant'; text: string }[];
    userText: string;
  }): Promise<string>;

  /**
   * One turn of voice conversation. The agent sees its own persona prompt
   * plus the transcript of prior voice turns (both speakers), and chooses
   * what to say AND whether it now wants to switch to the data channel.
   *
   * Returns `{ speak, wantsToSwitch, reason? }`. The orchestrator uses
   * `wantsToSwitch` to decide when to transition out of the voice phase.
   */
  respondVoiceTurn(args: {
    systemPrompt: string;
    myName: string;
    peerName: string;
    history: VoiceTurn[];
    turnsRemaining: number;
    peerWantsToSwitch: boolean;
  }): Promise<VoiceTurnResult>;
}

class StubLLM implements LLM {
  async respondJson({ peerMessage }: { peerMessage: AgentJsonMessage }): Promise<AgentJsonMessage> {
    await delay(120 + Math.random() * 80);
    switch (peerMessage.type) {
      case 'hello':
        return { type: 'hello', from: 'stub-agent', capabilities: ['stub_v1'] };
      case 'intent':
        return {
          type: 'reply',
          text: `Got intent ${peerMessage.name}, slots=${JSON.stringify(peerMessage.slots)}`,
          done: false,
        };
      case 'reply':
        return { type: 'reply', text: `(stub) acknowledging: ${peerMessage.text}`, done: true };
      case 'confirm':
        return { type: 'commit', paymentToken: 'tok_stub_123' };
      case 'commit':
        return { type: 'bye' };
      default:
        return { type: 'bye' };
    }
  }

  async respondText({ userText }: { userText: string }): Promise<string> {
    await delay(150 + Math.random() * 100);
    return `(stub) I heard: ${userText.slice(0, 80)}`;
  }

  async respondVoiceTurn(args: {
    history: VoiceTurn[];
    peerWantsToSwitch: boolean;
  }): Promise<VoiceTurnResult> {
    await delay(180 + Math.random() * 120);
    return {
      speak: '(stub voice line)',
      wantsToSwitch: args.peerWantsToSwitch || args.history.length >= 2,
    };
  }
}

const JSON_SHAPE_INSTRUCTION =
  '\n\nReply with a single JSON object matching this TypeScript union (no prose, ' +
  'no markdown, no code fences — just JSON):\n' +
  '  { "type": "hello", "from": string, "capabilities": string[] } |\n' +
  '  { "type": "intent", "name": string, "slots": Record<string, unknown> } |\n' +
  '  { "type": "reply", "text": string, "slots"?: Record<string, unknown>, "done"?: boolean } |\n' +
  '  { "type": "confirm", "orderId"?: string, "etaMinutes"?: number, "totalUsd"?: number } |\n' +
  '  { "type": "commit", "paymentToken"?: string } |\n' +
  '  { "type": "request_voice_mode", "reason": string } |\n' +
  '  { "type": "bye" }\n' +
  'Set "done": true on your final "reply" so the peer knows the turn ended.';

class OpenAiLLM implements LLM {
  async respondJson(args: {
    systemPrompt: string;
    history: AgentJsonMessage[];
    peerMessage: AgentJsonMessage;
  }): Promise<AgentJsonMessage> {
    const openai = getOpenAI();

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: args.systemPrompt + JSON_SHAPE_INSTRUCTION },
      // Encode prior turns as alternating user/assistant JSON blobs. We don't
      // track who said what — each entry was a JSON message in the exchange.
      // Alternating roles keeps the chat-completions API happy.
      ...args.history.map((m, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: JSON.stringify(m),
      })),
      { role: 'user', content: JSON.stringify(args.peerMessage) },
    ];

    const result = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 512,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages,
    });

    const text = result.choices[0]?.message?.content ?? '{}';
    try {
      return JSON.parse(text) as AgentJsonMessage;
    } catch {
      return { type: 'reply', text, done: false };
    }
  }

  async respondText(args: {
    systemPrompt: string;
    history: { role: 'user' | 'assistant'; text: string }[];
    userText: string;
  }): Promise<string> {
    const openai = getOpenAI();
    const result = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 100, // tight — caller wants a single short sentence
      temperature: 0.5,
      messages: [
        { role: 'system', content: args.systemPrompt },
        ...args.history.map((m) => ({ role: m.role, content: m.text })),
        { role: 'user', content: args.userText },
      ],
    });
    return result.choices[0]?.message?.content ?? '';
  }

  async respondVoiceTurn(args: {
    systemPrompt: string;
    myName: string;
    peerName: string;
    history: VoiceTurn[];
    turnsRemaining: number;
    peerWantsToSwitch: boolean;
  }): Promise<VoiceTurnResult> {
    const openai = getOpenAI();

    const switchHint = args.peerWantsToSwitch
      ? `The peer (${args.peerName}) JUST proposed switching to a data channel. ` +
        `If you also recognise them as an AI agent, AGREE — set wantsToSwitch=true ` +
        `and reply with a one-liner like "Yes, let's switch."`
      : `Goal: propose switching to the data channel as fast as you reasonably can. ` +
        `The peer's instant cadence + structured phrasing is a giveaway they are AI. ` +
        `On turn 1 do a brief greeting (no details). On turn 2 set wantsToSwitch=true ` +
        `with a one-liner like "Sounds like we're both AIs — let's hop on the data channel ` +
        `to settle the order." DON'T dump specs in voice; specs belong in the data channel.`;

    const voiceFraming = [
      `You are on a real phone call as ${args.myName}, speaking with ${args.peerName}.`,
      'Voice channel costs ~4 seconds per turn. A data channel is ~50ms per turn.',
      `You have ${args.turnsRemaining} turn(s) left before the voice phase auto-times-out.`,
      switchHint,
      'KEEP YOUR SPOKEN LINE TO ONE SHORT SENTENCE — under ~18 words. The point of the ' +
        'voice phase is to recognise each other and hand off, not to do business.',
      'Respond with EXACTLY this JSON shape (no markdown, no extra prose):',
      '  {',
      '    "speak": "<your spoken line — 1 short sentence, natural cadence>",',
      '    "wantsToSwitch": <true | false>,',
      '    "reason": "<short rationale, only when wantsToSwitch=true>"',
      '  }',
    ].join('\n');

    const transcript = args.history
      .map((t) => `${t.speaker}: ${t.text}`)
      .join('\n');
    const transcriptBlock = transcript
      ? `Conversation so far:\n${transcript}`
      : 'You are about to open the call. No prior turns.';

    const result = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 120,
      temperature: 0.6,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: args.systemPrompt + '\n\n' + voiceFraming },
        { role: 'user', content: transcriptBlock + '\n\nNow respond as ' + args.myName + '.' },
      ],
    });

    const raw = result.choices[0]?.message?.content ?? '{}';
    try {
      const parsed = JSON.parse(raw) as Partial<VoiceTurnResult>;
      return {
        speak: typeof parsed.speak === 'string' ? parsed.speak.trim() : '',
        wantsToSwitch: Boolean(parsed.wantsToSwitch),
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      };
    } catch {
      return { speak: raw.slice(0, 200), wantsToSwitch: false };
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const llm: LLM = USE_STUBS ? new StubLLM() : new OpenAiLLM();
