/**
 * Stream framing for envelopes.
 *
 * Unix sockets and TCP are byte streams with no message boundaries, so every
 * link that carries envelopes needs a framing. We use newline-delimited JSON:
 * `JSON.stringify` never emits a literal newline (control chars inside strings
 * are escaped), so a single '\n' is an unambiguous frame terminator.
 *
 * This lives in `protocol` because framing is part of the wire contract — the
 * one thing every tier that speaks envelopes must agree on. It stays free of
 * any Node API so it is usable from a browser Viewer too; callers decode their
 * socket bytes to a string (e.g. via a StringDecoder) before feeding `push`.
 */
import { PROTOCOL_VERSION } from "./version.js";
import { Envelope, parseEnvelope, type Body, type ParseResult } from "./envelope.js";

/** Serialize one envelope to a single NDJSON frame (trailing newline included). */
export function encodeFrame(env: Envelope): string {
  return JSON.stringify(env) + "\n";
}

/**
 * Assemble a validated envelope. Fills `v` and validates the whole frame, so a
 * tier can only put well-formed messages on the wire. `id` and `ts` are passed
 * in rather than minted here to keep this module free of a clock and a source
 * of randomness (both of which would tie it to a runtime).
 */
export function makeEnvelope(parts: {
  id: string;
  ts: number;
  from: string;
  to: string;
  body: Body;
  replyTo?: string;
}): Envelope {
  const raw: Record<string, unknown> = {
    v: PROTOCOL_VERSION,
    id: parts.id,
    ts: parts.ts,
    from: parts.from,
    to: parts.to,
    body: parts.body,
  };
  // exactOptionalPropertyTypes: only set replyTo when actually present.
  if (parts.replyTo !== undefined) raw["replyTo"] = parts.replyTo;
  return Envelope.parse(raw);
}

/**
 * Streaming NDJSON reader. Push decoded text as it arrives off the socket; get
 * back one ParseResult per completed frame. Partial trailing lines are held
 * until their newline arrives. A frame that never terminates is capped so a
 * misbehaving or malicious peer can't grow the buffer without bound.
 */
export class FrameReader {
  private buf = "";
  private readonly maxFrameChars: number;

  constructor(maxFrameChars = 8 * 1024 * 1024) {
    this.maxFrameChars = maxFrameChars;
  }

  push(text: string): ParseResult[] {
    this.buf += text;
    const out: ParseResult[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      out.push(decodeLine(line));
    }
    if (this.buf.length > this.maxFrameChars) {
      this.buf = "";
      out.push({ ok: false, error: "frame exceeded maximum length; connection buffer reset" });
    }
    return out;
  }
}

function decodeLine(line: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: "invalid JSON frame" };
  }
  return parseEnvelope(raw);
}
