/**
 * Register slash commands with Discord.
 * Auto-discovers every command in src/commands/ (the same list the bot
 * itself loads at runtime — see index.js) so this file can never drift
 * out of sync with what's actually implemented.
 *
 * Run this once, and again any time you add/remove a command, or change a
 * command's name/description/options:
 *   npm run deploy
 *
 * Global commands (the default) can take up to ~1 hour to show up
 * everywhere, and Discord's client sometimes caches old command
 * descriptions until you restart it. If you set GUILD_ID in .env, this
 * script registers to that one server instead, which updates instantly —
 * handy while testing changes. Right-click your server icon → "Copy
 * Server ID" to get it (enable Developer Mode in Discord settings first).
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
const commandFiles = readdirSync(commandsDir).filter((file) => file.endsWith('.js'));

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

console.log(`Registering ${commands.length} slash command(s): ${commands.map((c) => c.name).join(', ')}`);

try {
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`✅ Registered instantly to guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Registered globally (can take up to ~1 hour to fully propagate).');
    console.log('   Tip: set GUILD_ID in .env for instant updates while testing.');
  }
} catch (err) {
  console.error('❌ Failed to register commands:', err);
  process.exit(1);
}
