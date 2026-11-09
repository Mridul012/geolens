// Structured JSON logging only (Engineering-Rules §4). `console.log` is a lint error.
import { pino, type Logger } from "pino";
import { env } from "../../config/env.js";

const redactPaths = [
  "req.headers.cookie",
  "req.headers.authorization",
  "res.headers['set-cookie']",
  "password",
  "*.password",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
];

export function createLogger(bindings: Readonly<Record<string, string>>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: bindings,
    redact: { paths: redactPaths, censor: "[redacted]" },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}

export type { Logger };
