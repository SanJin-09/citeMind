const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /((?:ark|api)[_-]?key\s*[:=]\s*)[^\s,;]+/gi,
];

export function redactLogText(value: unknown): string {
  let text =
    value instanceof Error ? (value.stack ?? value.message) : String(value);

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "$1[REDACTED]");
  }

  return text;
}

function write(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  detail?: unknown,
): void {
  const suffix = detail === undefined ? "" : ` ${redactLogText(detail)}`;
  console.error(`[${level}] ${message}${suffix}`);
}

export const logger = {
  info: (message: string, detail?: unknown): void =>
    write("INFO", message, detail),
  warn: (message: string, detail?: unknown): void =>
    write("WARN", message, detail),
  error: (message: string, detail?: unknown): void =>
    write("ERROR", message, detail),
};
