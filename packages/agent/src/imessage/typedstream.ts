/**
 * attributedBody text extraction. Since macOS Ventura, a message's body often
 * lives only in `message.attributedBody` — an NSArchiver *typedstream* blob —
 * with the `text` column NULL. A full typedstream parser is a project of its
 * own; like most open-source readers we use the well-trodden heuristic: the
 * first NSString/NSMutableString payload in the stream IS the plain text,
 * and it sits right after a '+' (0x2B) marker as a length-prefixed UTF-8 run
 * (1-byte length, or 0x81 + uint16le, or 0x82 + uint32le).
 *
 * Anything inconsistent returns null — the caller falls back to a placeholder
 * rather than showing garbage. Pure function; unit-tested with synthesized
 * blobs in tests/imessage.mjs.
 */

const NEEDLES = [Buffer.from("NSString"), Buffer.from("NSMutableString")];

export function decodeAttributedBody(body: Uint8Array | null | undefined): string | null {
  if (!body || body.byteLength === 0) return null;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);

  // Earliest string-class marker wins (the first string object is the text).
  let at = -1;
  for (const n of NEEDLES) {
    const i = buf.indexOf(n);
    if (i >= 0 && (at < 0 || i + n.length < at)) at = i + n.length;
  }
  if (at < 0) return null;

  // Skip the class metadata to the '+' marker that precedes the payload.
  let plus = -1;
  for (let i = at; i < Math.min(at + 24, buf.length); i++) {
    if (buf[i] === 0x2b) {
      plus = i;
      break;
    }
  }
  if (plus < 0 || plus + 1 >= buf.length) return null;

  let i = plus + 1;
  let len = buf[i]!;
  if (len === 0x81) {
    if (i + 3 > buf.length) return null;
    len = buf.readUInt16LE(i + 1);
    i += 3;
  } else if (len === 0x82) {
    if (i + 5 > buf.length) return null;
    len = buf.readUInt32LE(i + 1);
    i += 5;
  } else {
    i += 1;
  }
  if (len <= 0 || i + len > buf.length) return null;
  return buf.subarray(i, i + len).toString("utf8");
}
