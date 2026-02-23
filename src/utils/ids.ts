import crypto from "node:crypto";

export function newId(): string {
  return crypto.randomUUID();
}

export function nowTs(): number {
  return Date.now();
}
