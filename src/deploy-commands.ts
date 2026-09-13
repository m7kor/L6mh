/**
 * Register slash commands with Discord.
 * Uses individual PATCH/POST/DELETE instead of bulk PUT to handle Entry Point commands.
 *
 * Run this once, and again any time you add/remove a command:
 *   npm run deploy
 *
 * Set GUILD_ID in .env for instant updates while testing.
 */

import 'dotenv/config';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { REST, Routes } from 'discord.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

const commandsDir = join(__dirname, 'commands');
const commandFiles = readdirSync(commandsDir).filter((file) => file.endsWith('.ts') || file.endsWith('.js'));

const commands = [];
for (const file of commandFiles) {
  const commandModule = await import(`./commands/${file}`);
  if (commandModule.data) {
    commands.push(commandModule.data.toJSON());
  } else {
    console.warn(`Skipped ${file}: missing "data" export.`);
  }
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const route = GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);

console.log(`Target: ${GUILD_ID ? `guild ${GUILD_ID}` : 'global'}`);
console.log(`New commands: ${commands.map(c => c.name).join(', ')}`);

// Step 1: Fetch existing commands
console.log('Fetching existing commands...');
const existing = (await rest.get(route)) as Array<{ id: string; name: string }>;
console.log(`Found ${existing.length} existing: ${existing.map(c => c.name).join(', ')}`);

const newNames = new Set(commands.map(c => c.name));
const existingMap = new Map(existing.map(c => [c.name, c]));

// Step 2: Delete commands that no longer exist
for (const ex of existing) {
  if (!newNames.has(ex.name)) {
    console.log(`Deleting: ${ex.name} (${ex.id})`);
    await rest.delete(Routes.applicationCommand(CLIENT_ID, ex.id));
  }
}

// Step 3: Create or update commands
for (const cmd of commands) {
  const ex = existingMap.get(cmd.name);
  if (ex) {
    console.log(`Updating: ${cmd.name}`);
    await rest.patch(Routes.applicationCommand(CLIENT_ID, ex.id), { body: cmd });
  } else {
    console.log(`Creating: ${cmd.name}`);
    await rest.post(route, { body: cmd });
  }
}

console.log(`✅ Done! ${commands.length} commands registered.`);
