import fs from 'node:fs';
import path from 'node:path';

// Log file configuration
const LOG_DIR = path.resolve('./logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_LOG_FILES = 5; // Keep 5 rotated files

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath(): string {
  return path.join(LOG_DIR, 'bot.log');
}

function rotateIfNeeded(): void {
  const logPath = getLogFilePath();
  if (!fs.existsSync(logPath)) return;

  const stats = fs.statSync(logPath);
  if (stats.size < MAX_LOG_SIZE) return;

  // Rotate: bot.log.4 -> delete, bot.log.3 -> bot.log.4, ... bot.log -> bot.log.1
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    const from = path.join(LOG_DIR, `bot.log.${i}`);
    const to = path.join(LOG_DIR, `bot.log.${i + 1}`);
    if (fs.existsSync(from)) {
      if (i === MAX_LOG_FILES - 1) {
        fs.unlinkSync(from);
      } else {
        fs.renameSync(from, to);
      }
    }
  }

  fs.renameSync(logPath, path.join(LOG_DIR, 'bot.log.1'));
}

function writeToFile(line: string): void {
  try {
    ensureLogDir();
    rotateIfNeeded();
    fs.appendFileSync(getLogFilePath(), line + '\n');
  } catch {
    // Don't crash the bot over a log write failure
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatArgs(args: any[]): string {
  return args.map(arg => {
    if (arg instanceof Error) {
      return `${arg.message}\n${arg.stack}`;
    }
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
}

export const logger = {
  info(...args: any[]): void {
    const msg = formatArgs(args);
    const line = `[${timestamp()}] [INFO] ${msg}`;
    console.log(line);
    writeToFile(line);
  },

  warn(...args: any[]): void {
    const msg = formatArgs(args);
    const line = `[${timestamp()}] [WARN] ${msg}`;
    console.warn(line);
    writeToFile(line);
  },

  error(...args: any[]): void {
    const msg = formatArgs(args);
    const line = `[${timestamp()}] [ERROR] ${msg}`;
    console.error(line);
    writeToFile(line);
  },

  debug(...args: any[]): void {
    const msg = formatArgs(args);
    const line = `[${timestamp()}] [DEBUG] ${msg}`;
    console.log(line);
    writeToFile(line);
  },

  command(commandName: string, userId: string, userName: string, guildId: string | null, options: Record<string, any>): void {
    const optStr = Object.keys(options).length > 0 ? ` | Options: ${JSON.stringify(options)}` : '';
    const guild = guildId ? ` | Guild: ${guildId}` : ' | DM';
    const line = `[${timestamp()}] [CMD] /${commandName} | User: ${userName} (${userId})${guild}${optStr}`;
    console.log(line);
    writeToFile(line);
  },

  commandComplete(commandName: string, userId: string, durationMs: number, result: string): void {
    const line = `[${timestamp()}] [CMD-DONE] /${commandName} | User: ${userId} | ${durationMs}ms | ${result}`;
    console.log(line);
    writeToFile(line);
  },

  commandError(commandName: string, userId: string, error: any): void {
    const errMsg = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    const line = `[${timestamp()}] [CMD-ERR] /${commandName} | User: ${userId} | ${errMsg}`;
    console.error(line);
    writeToFile(line);
  },
};
