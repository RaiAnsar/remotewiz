import Anthropic from "@anthropic-ai/sdk";
import type { SummarizerInput } from "../types.js";
import { redactSecrets } from "../utils/redact.js";

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  allow(): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = now;
    }

    if (this.tokens < 1) {
      return false;
    }

    this.tokens -= 1;
    return true;
  }
}

const SYSTEM_PROMPT = [
  "Summarize this Claude Code output for someone reading on their phone.",
  "Use exactly this format:",
  "",
  "**Status**: success | partial | failed",
  "**Changes**: bullet list of files modified/created/deleted",
  "**Verified**: what was tested or checked (build, lint, tests)",
  "**Issues**: any errors, warnings, or skipped items",
  "**Next**: suggested follow-up actions if any",
  "**Tokens**: X / Y budget used",
  "",
  "If there are any 'Actions during approved replay' listed in the input,",
  "add a **Replay** section listing exactly what actions were taken with elevated permissions.",
  "This is critical for security auditability.",
  "",
  "Keep total response under 300 words.",
].join("\n");

export class Summarizer {
  private readonly bucket = new TokenBucket(10, 10 / 60_000);
  private readonly anthropic?: Anthropic;

  constructor(
    apiKey: string | undefined,
    private readonly enabled: boolean,
  ) {
    if (enabled && apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }
  }

  async summarize(input: SummarizerInput): Promise<string> {
    const redactedRaw = redactSecrets(input.rawText);

    // If we have clean assistant text, return it directly — no need for AI summarization
    const assistantText = input.assistantText?.trim();
    if (assistantText) {
      return redactSecrets(assistantText).slice(0, 4000);
    }

    // Try to extract readable text from raw stream output
    const extracted = this.extractReadableText(redactedRaw);
    if (extracted) {
      return redactSecrets(extracted).slice(0, 4000);
    }

    // Only use AI summarizer for cases where we have raw output but no clean text
    if (this.enabled && this.anthropic && this.bucket.allow()) {
      const body = [
        `Tokens used: ${input.tokensUsed} / ${input.tokenBudget}`,
        input.replayActions && input.replayActions.length > 0
          ? `Actions during approved replay: ${input.replayActions.join(", ")}`
          : "Actions during approved replay: none",
        input.toolSummary.length > 0 ? `Tool summary:\n- ${input.toolSummary.join("\n- ")}` : "Tool summary: none",
        "",
        "Raw output:",
        redactedRaw.slice(0, 120_000),
      ].join("\n");

      try {
        const response = await this.anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 800,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: body }],
        });

        const text = response.content
          .map((chunk) => (chunk.type === "text" ? chunk.text : ""))
          .join("\n")
          .trim();

        if (text) {
          return redactSecrets(text);
        }
      } catch {
        // Fall through to fallback
      }
    }

    return this.fallback(redactedRaw, input);
  }

  private fallback(raw: string, input: SummarizerInput): string {
    const displayText = this.extractReadableText(raw);
    if (displayText) {
      return displayText.slice(0, 4000);
    }
    return "(No readable output captured)";
  }

  private extractReadableText(raw: string): string {
    // Try to extract assistant text from raw stream-json lines
    const lines = raw.split("\n").filter(Boolean);
    const texts: string[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        // Skip system/hook events
        if (parsed.type === "system" || parsed.subtype?.startsWith("hook")) continue;
        // Extract result text
        if (parsed.result && typeof parsed.result === "string") {
          texts.push(parsed.result);
        }
        // Extract assistant messages
        if ((parsed.role === "assistant" || parsed.type === "assistant") && parsed.content) {
          if (typeof parsed.content === "string") {
            texts.push(parsed.content);
          } else if (Array.isArray(parsed.content)) {
            for (const block of parsed.content) {
              if (block.type === "text" && block.text) texts.push(block.text);
            }
          }
        }
      } catch {
        // Not JSON — include raw line if it doesn't look like JSON
        if (!line.startsWith("{")) {
          texts.push(line);
        }
      }
    }

    return texts.join("\n").trim();
  }
}
