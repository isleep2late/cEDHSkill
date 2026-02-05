import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show help for cEDHSkill commands')
  .addStringOption(option =>
    option
      .setName('section')
      .setDescription('Select a help topic')
      .setRequired(true)
      .addChoices(
        { name: 'Info', value: 'info' },
        { name: 'Player Commands', value: 'player' },
        { name: 'Deck Commands', value: 'deck' },
        { name: 'Stats Commands', value: 'stats' },
        { name: 'Admin Commands', value: 'admin' },
        { name: 'Credits', value: 'credits' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;
  const section = interaction.options.getString('section', true);
  const isAdmin = config.admins.includes(userId);

  const embed = new EmbedBuilder()
    .setTitle('cEDHSkill Help')
    .setColor('Blue');

  switch (section) {
    case 'info':
      embed
        .setDescription('**cEDHSkill** is our enhanced OpenSkill-based rating system.')
        .addFields(
          { name: 'Mu & Sigma', value: 'Mu represents skill. Sigma is confidence in the rating.' },
          { name: 'Elo Conversion', value: '`Elo = 1000 + (mu-25)*12 - (sigma-8.333)*4`' },
          { name: 'Turn Order Tracking', value: 'Optional feature to track performance by turn position.' },
          { name: 'Dual Systems', value: 'Separate ranking systems for players and commanders/decks.' },
          { name: 'Qualification', value: 'Minimum 5 games required to appear in official rankings.' },
          { name: 'Game Modes', value: 'Supports 4 player games with win/loss/draw results only. (3-player games disabled by default)' },
          { name: 'Participation Bonus', value: 'All players receive +1 Elo for every ranked game played.' },
          { name: 'Rating Decay', value: `After ${config.decayStartDays} days of inactivity, players lose -1 Elo per day (stops at 1050 Elo). Decay only applies to players who have played at least 1 ranked game.` }
        );
      break;

    case 'player':
      embed.setDescription('**Player Ranking Commands:**')
        .addFields(
          { name: '/rank', value: 'Submit player game results (4 players, w/l/d only). Can include commanders assigned to players. Optional turn order tracking with reactions OR inline specification (e.g., @user w 1 for Turn 1). Also supports deck-only mode when no players are mentioned.' },
          { name: '/list [count]', value: 'Show top N players (1-64, includes ties). Shows qualification status.' },
          { name: '/viewstats @user', value: 'View detailed player stats: rating, rank, W/L/D record, and turn order performance.' },
          { name: '/predict [@users...]', value: 'Predict win chances for players/decks using Elo, turn order, and hybrid predictions. Shows overall turn order win% if no input.' },
          { name: '/set [commander] [gameid] [1-4]', value: 'Retroactively assign your turn order and/or commander for a specific game using the game ID.' }
        );
      break;

    case 'deck':
      embed.setDescription('**Commander/Deck Ranking Commands:**')
        .addFields(
          { name: '/rank (deck mode)', value: 'When no @users are mentioned, /rank works as deck-only mode - ORDER MATTERS! First mentioned = Turn 1, second = Turn 2, etc. Format: "commander-name w/l/d commander-name w/l/d"' },
          { name: '/list deck [count]', value: 'Show top N commanders (1-64, includes ties). Displays Elo and qualification status.' },
          { name: '/viewstats [commander]', value: 'View commander stats: rating, rank, W/L/D record, win rate, and turn order performance.' }
        );
      break;

    case 'stats':
      embed.setDescription('**Statistics & Information Commands:**')
        .addFields(
          { name: '/leaguestats', value: 'Comprehensive league overview: total players, games played, qualification rates, and activity metrics.' },
          { name: '/predict', value: 'General turn order statistics across all players when used without arguments.' }
        );
      break;

   case 'admin':
  if (!isAdmin) {
    embed.setDescription('Admin commands are only available to bot administrators.');
    break;
  }
  embed.setDescription('**Admin Commands:**')
    .addFields(
      {
        name: 'Unified Match Management',
        value: '`/undo [gameid]` - Revert match/set/decay (latest or specific game ID)\n' +
               '`/redo` - Reapply most recent undone operation\n'
      },
      { 
        name: 'Game Injection (NEW)', 
        value: '`/rank aftergame:GAMEID` - Inject player game after specified game ID\n' +
               '*Automatically recalculates all ratings chronologically*'
      },
      { 
        name: 'Player Management', 
        value: '`/restrict @user` - Ban user from ranked games\n' +
               '`/vindicate @user` - Unban user and clear suspicion\n' +
               '`/reanimate @user` - Remove suspicion exemption'
      },
      { 
        name: 'System Management', 
        value: '`/backup` - Download database backup via DM\n' +
               '`/snap` - Delete all unconfirmed game messages (both player and deck games)\n' +
               '`/set @user|deck-name parameters` - Directly modify player or deck ratings\n' +
               'Parameters: `mu:25.0 sigma:8.3 elo:1200 wld:3/4/5` (any combination, any order)'
      },
      { 
        name: 'History & Data Export (Admin Only)', 
        value: '`/printhistory [target]` - Export detailed history to text file:\n' +
               '  • No target: Complete league history\n' +
               '  • `admin`: Admin activity report\n' +
               '  • `players`: All players report\n' +
               '  • `decay`: All rating decay logs\n' +
               '  • `setrank`: All manual rating adjustments\n' +
               '  • `undo`: All undo/redo operations\n' +
               '  • `player:@user`: Specific player history\n' +
               '  • `commander:deck-name`: Specific deck history'
      },
      {
        name: 'Season Management',
        value: '`/thanossnap` - End season, show rankings, reset data\n'
      },
      {
        name: 'Testing & Development (Admin Only)',
        value: '`/timewalk [days]` - Simulate time passing for decay testing\n' +
               '• Tracks cumulative virtual time (first call: grace+1 days, then +1 day each)\n' +
               '• Virtual time resets on rating recalculation or bot restart\n' +
               '*For testing purposes only - not recommended for production use*'
      }
    );
  break;

    case 'credits':
      embed.setDescription([
        '**👨‍💻 Lead developer:** isleep2late',
        '**👨‍💻 Dev Team:** J who helped set up the initial logic integration & AEtheriumSlinky who has contributed in a significant manner to additional logic',
        '**🧮 OpenSkill:** https://github.com/philihp/openskill.js',
        '**📊 Research:** https://www.csie.ntu.edu.tw/~cjlin/papers/online_ranking/online_journal.pdf',
        '**📖 Thank you to LLMs** for assisting with debugging the code.',
        '**⚔️ Shout out to ASM** for creating a ranked bot many years ago. Features such as "reaction confirmation" were inspired by this.',
        '**🙏 Thank you to everyone in the cEDH Bot Testing server** for enabling this project to thrive, and thank you to everyone in the cEDH community for your support in making this possible!'
      ].join('\n'));
      break;
  }

  await interaction.reply({ embeds: [embed] });
}