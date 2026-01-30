// Helper function to parse comma-separated IDs
function parseIds(envVar: string | undefined, defaultValue: string[] = []): string[] {
  if (!envVar || envVar.trim() === '') return defaultValue;
  return envVar.split(',').map(id => id.trim()).filter(id => id !== '');
}

// Validate required environment variables
const requiredEnvVars = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingVars.join(', ')}\n` +
    'Please create a .env file based on .env.example'
  );
}

export const config = {
  token: process.env.DISCORD_TOKEN!,
  clientId: process.env.CLIENT_ID!,
  guildId: process.env.GUILD_ID!,
  admins: parseIds(process.env.ADMINS),
  moderators: parseIds(process.env.MODERATORS),
  decayStartDays: parseInt(process.env.DECAY_START_DAYS || '6', 10)
};