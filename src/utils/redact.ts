const REDACTION_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]+/g,
  /xoxb-[a-zA-Z0-9-]+/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /ANTHROPIC_API_KEY\s*=\s*\S+/gi,
  /password["'\s:=]+\S+/gi,
  /AIza[0-9A-Za-z\-_]{35}/g,
];

const BASE64_BLOCK_PATTERN = /(?:[A-Za-z0-9+/]{40,}={0,2})/g;

function looksHighEntropy(input: string): boolean {
  const unique = new Set(input).size;
  return unique >= 12;
}

export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of REDACTION_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  output = output.replace(BASE64_BLOCK_PATTERN, (match) => (looksHighEntropy(match) ? "[REDACTED]" : match));
  return output;
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      next[key] = redactUnknown(entry);
    }
    return next;
  }
  return value;
}
