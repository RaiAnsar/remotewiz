function timestamp(): string {
  return new Date().toISOString();
}

export function logInfo(message: string, data?: unknown): void {
  if (data === undefined) {
    console.log(`[${timestamp()}] INFO ${message}`);
    return;
  }
  console.log(`[${timestamp()}] INFO ${message}`, data);
}

export function logWarn(message: string, data?: unknown): void {
  if (data === undefined) {
    console.warn(`[${timestamp()}] WARN ${message}`);
    return;
  }
  console.warn(`[${timestamp()}] WARN ${message}`, data);
}

export function logError(message: string, error?: unknown): void {
  if (error === undefined) {
    console.error(`[${timestamp()}] ERROR ${message}`);
    return;
  }
  console.error(`[${timestamp()}] ERROR ${message}`, error);
}
