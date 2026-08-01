import { describe, expect, it } from 'vitest';
import { buildAnswerXml, escapeXml } from './answerXml';

describe('buildAnswerXml', () => {
  it('originator leg gets Stream then Dial to the peer', () => {
    const xml = buildAnswerXml({
      role: 'dial_originator',
      streamUrl: 'wss://host.example.com/voice/abc',
      dialTo: '+1BBBBBBBBBB',
      dialCallerId: '+1AAAAAAAAAA',
    });
    expect(xml).toContain('<Stream keepCallAlive="true" bidirectional="true" audioTrack="inbound"');
    expect(xml).toContain('wss://host.example.com/voice/abc');
    expect(xml).toContain('<Dial timeout="30" callerId="+1AAAAAAAAAA"><Number>+1BBBBBBBBBB</Number></Dial>');
    // Stream must be attached before the Dial executes.
    expect(xml.indexOf('<Stream')).toBeLessThan(xml.indexOf('<Dial'));
    // The bridge only works without a Conference mixer in the path.
    expect(xml).not.toContain('<Conference');
  });

  it('callee leg gets Stream then Wait, no Dial', () => {
    const xml = buildAnswerXml({
      role: 'callee',
      streamUrl: 'wss://host.example.com/voice/def',
    });
    expect(xml).toContain('<Stream keepCallAlive="true"');
    expect(xml).toContain('<Wait length="600"/>');
    expect(xml).not.toContain('<Dial');
    expect(xml).not.toContain('<Conference');
  });

  it('throws when the originator has no dial target', () => {
    expect(() =>
      buildAnswerXml({ role: 'dial_originator', streamUrl: 'wss://x/voice/1' }),
    ).toThrow(/dialTo required/);
  });

  it('escapes XML-hostile characters in URLs and numbers', () => {
    const xml = buildAnswerXml({
      role: 'dial_originator',
      streamUrl: 'wss://host/voice/a?x=1&y=2',
      dialTo: '+1<script>',
    });
    expect(xml).toContain('wss://host/voice/a?x=1&amp;y=2');
    expect(xml).toContain('<Number>+1&lt;script&gt;</Number>');
  });

  it('escapeXml handles all five specials', () => {
    expect(escapeXml('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e');
  });
});
