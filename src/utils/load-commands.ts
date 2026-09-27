/**
 * Command discovery — single source of truth for finding and importing
 * slash-command modules.
 *
 * Both the runtime (index.ts) and the deployer (deploy-commands.ts) use this,
 * so "what the bot loads" and "what gets registered" can never drift apart.
 *
 * Note the extension filter accepts BOTH `.ts` and `.js`: under `tsx` the
 * loader runs from `src/` where sources are `.ts`, while a production build
 * runs from `dist/` where they are `.js`. Filtering on `.js` alone silently
 * loaded zero commands in development.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const COMMAND_EXTENSIONS = ['.ts', '.js'] as const;

export interface LoadedCommand {
  /** The imported module, guaranteed to expose `data` and `execute`. */
  module: SlashCommandModule;
  /** Bare filename including extension, for logging. */
  file: string;
}

/** Structural shape of a command module. */
export interface SlashCommandModule {
  /** A discord.js SlashCommandBuilder (or anything with `name` and `toJSON`). */
  data: { name: string; toJSON(): unknown };
  execute(...args: any[]): unknown;
}

/**
 * Import every command module in the `commands/` directory next to this file.
 * Modules missing a `data` or `execute` export are skipped with a warning
 * rather than crashing the boot — one malformed file should not take the
 * whole bot offline.
 */
export async function loadCommandModules(log?: (msg: string) => void): Promise<LoadedCommand[]> {
  const commandsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');

  let files: string[];
  try {
    files = readdirSync(commandsDir);
  } catch (err) {
    log?.(`Could not read commands directory (${commandsDir}): ${(err as Error).message}`);
    return [];
  }

  const candidates = files.filter((file) =>
    COMMAND_EXTENSIONS.some((ext) => file.endsWith(ext)) && !file.startsWith('.'),
  );

  // Sort for a deterministic load order — slash command registration order and
  // the startup log line should not depend on filesystem enumeration order.
  candidates.sort();

  const loaded: LoadedCommand[] = [];
  for (const file of candidates) {
    try {
      const module = await import(`../commands/${file}`);
      if (module?.data && module?.execute) {
        loaded.push({ module, file });
      } else {
        log?.(`Skipped commands/${file}: missing "data" or "execute" export.`);
      }
    } catch (err) {
      log?.(`Failed to import commands/${file}: ${(err as Error).message}`);
    }
  }

  if (loaded.length === 0 && candidates.length > 0) {
    log?.(`Found ${candidates.length} command file(s) but loaded none.`);
  }

  return loaded;
}
