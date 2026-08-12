/**
 * A structural redaction logger. Register every plaintext secret the moment it
 * enters the process; the logger scrubs all of them from every line at the sink,
 * so even a careless later log call cannot leak one. Emits JSON lines.
 *
 * The sink is injected (no Node globals) so this stays usable everywhere.
 */
export class RedactingLogger {
  private readonly secrets = new Set<string>();

  constructor(private readonly sink: (line: string) => void) {}

  /** Register a plaintext value to be scrubbed from all future output. */
  register(secret: string): void {
    if (secret.length >= 3) this.secrets.add(secret);
  }

  private scrub(line: string): string {
    let out = line;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join("«redacted»");
    }
    return out;
  }

  log(event: string, fields: Record<string, unknown> = {}, ts = 0): void {
    this.sink(this.scrub(JSON.stringify({ ts, event, ...fields })));
  }
}
