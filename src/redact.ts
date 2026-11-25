const TOKENHUB_KEY_PATTERN = /\bsk-tokenhub-[A-Za-z0-9._-]+\b/g;

export function scrubSecrets(input: string, extraSecrets: readonly string[] = []): string {
  let out = input.replace(TOKENHUB_KEY_PATTERN, "[REDACTED]");
  for (const raw of extraSecrets) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      out = out.split(trimmed).join("[REDACTED]");
    }
  }
  return out;
}
