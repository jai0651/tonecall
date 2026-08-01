/**
 * Plivo answer-XML builders for the AVIP-1 Dial-bridge topology.
 *
 * Two roles:
 *
 *   dial_originator — the leg /api/trigger-call originated. Attaches the
 *     audio <Stream> first, then <Dial>s the peer DID. Once the peer
 *     answers, Plivo bridges the two legs over real PSTN/SIP — audio and
 *     DTMF cross end-to-end (verified by the dial-dtmf probe), which is
 *     what lets the in-band nonce handshake work on real calls.
 *
 *   callee — any leg that was dialed INTO: the peer agent's DID, or a human
 *     calling one of our numbers directly. <Stream> + <Wait> keeps the leg
 *     alive while the state machine listens for a preamble (agent) or falls
 *     through to voice mode (human).
 *
 * NB: <Stream bidirectional="true"> requires audioTrack="inbound" (Plivo
 * platform constraint) — with a Dial bridge that's exactly what we want:
 * each leg's stream hears what the OTHER side of the bridge sends.
 */

export type AnswerRole = 'dial_originator' | 'callee';

// How long a callee leg stays up with no XML left to run. Generous — the
// demo hangs up via REST well before this.
const CALLEE_WAIT_SEC = Number(process.env.CALLEE_WAIT_SEC ?? 600);
// How long the <Dial> rings the peer DID before giving up.
const DIAL_TIMEOUT_SEC = Number(process.env.DIAL_TIMEOUT_SEC ?? 30);

export function buildAnswerXml(args: {
  role: AnswerRole;
  streamUrl: string;
  /** Peer DID to bridge to — required when role === 'dial_originator'. */
  dialTo?: string;
  /** Caller id shown to the dialed peer; defaults to the answering DID. */
  dialCallerId?: string;
}): string {
  const { role, streamUrl, dialTo, dialCallerId } = args;

  const stream =
    `<Stream keepCallAlive="true" bidirectional="true" audioTrack="inbound" ` +
    `contentType="audio/x-mulaw;rate=8000">${escapeXml(streamUrl)}</Stream>`;

  let inner: string;
  if (role === 'dial_originator') {
    if (!dialTo) throw new Error('buildAnswerXml: dialTo required for dial_originator');
    const callerIdAttr = dialCallerId ? ` callerId="${escapeXml(dialCallerId)}"` : '';
    inner =
      `${stream}\n<Dial timeout="${DIAL_TIMEOUT_SEC}"${callerIdAttr}>` +
      `<Number>${escapeXml(dialTo)}</Number></Dial>`;
  } else {
    inner = `${stream}\n<Wait length="${CALLEE_WAIT_SEC}"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${inner}\n</Response>`;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
