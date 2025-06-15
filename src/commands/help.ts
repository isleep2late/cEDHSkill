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
        { name: 'Rank', value: 'rank' },
        { name: 'List', value: 'list' },
        { name: 'Player Info', value: 'playerinfo' },
        { name: 'Predict', value: 'predict' },
        { name: 'Undo (Admin)', value: 'undo' },
        { name: 'Redo (Admin)', value: 'redo' },
        { name: 'Restrict (Admin)', value: 'restrict' },
        { name: 'Vindicate (Admin)', value: 'vindicate' },
        { name: 'Reanimate (Admin)', value: 'reanimate' },
        { name: 'Snap (Admin)', value: 'snap' },
        { name: 'Thanos Snap (Admin)', value: 'thanos-snap' },
        { name: 'Endgame (Admin)', value: 'endgame' },
        { name: 'Credits', value: 'credits' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;
  const section = interaction.options.getString('section', true);
  const isAdmin = config.admins.includes(userId);

  const adminOnly = new Set([
    'undo', 'redo', 'restrict', 'vindicate', 'snap', 'thanos-snap', 'endgame'
  ]);

  if (adminOnly.has(section) && !isAdmin) {
    await interaction.reply({ content: '❌ You do not have permission to view this help section.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('cEDHSkill Help')
    .setColor('Blue');

  switch (section) {
    case 'info':
      embed
        .setDescription('**cEDHSkill** is our enhanced OpenSkill-based rating system.')
        .addFields(
          { name: 'Mu & Sigma', value: 'Mu represents skill. Sigma is confidence in the rating.' },
          { name: 'Elo Conversion', value: 'Elo = 1000 + (mu-25)*12 - (sigma-8.333)*4' },
          { name: 'Rating Decay', value: `No decay until ${config.decayStartDays} days of inactivity. Decay slows as sigma increases.` }
        );
      break;

    case 'credits':
      embed.setDescription([
        '**Lead developer:** isleep2late',
        '**Co-developer:** J who helped set up the initial logic integration',
        '**OpenSkill:** https://github.com/philihp/openskill.js',
        '**Research:** https://www.csie.ntu.edu.tw/~cjlin/papers/online_ranking/online_journal.pdf',
        '**Thank you to ChatGPT** for assisting with debugging the code.',
        '**Shout out to ASM** for creating a ranked bot many years ago. Features such as "reaction confirmation" were inspired by this.',
        '**Thank you to everyone in the cEDH Bot Testing server** for enabling this project to thrive, and thank you to everyone in the cEDH community for your support in making this possible!'
      ].join('\n'));
      break;

    case 'rank':
      embed.setDescription([
        '/rank @user [team:label] [w/l/d or placement] ...',
        'Supports any number ≥2 of players, teams, mixed scores, and tied places.',
        'Results go limbo until all mentioned react 👍.',
        '(CURRENTLY IN CEDH MODE-ONLY ACCEPTS 3-4 PLAYERS AND UP TO 1 WINNER)'
      ].join('\n'));
      break;

    case 'list':
      embed.setDescription('/list count: Show top N players (1–50, includes ties at boundary).');
      break;

    case 'playerinfo':
      embed.setDescription('/playerinfo @user: View Elo, mu, sigma, W/L/D, and rank position.');
      break;

    case 'predict':
      embed.setDescription('/predict @p1 [team:Blue] @p2 [team:Red] ...: Guess win% for each player/team. (CEDH MODE=TEAM LABELS NOT ALLOWED)');
      break;

    case 'undo':
      embed.setDescription('Admin only: /undo = revert the most recent confirmed match.');
      break;

    case 'redo':
      embed.setDescription('Admin only: /redo = reapply the last undone match.');
      break;

    case 'restrict':
      embed.setDescription('Admin only: /restrict @user = ban from ranked');
      break;

    case 'vindicate':
      embed.setDescription('Admin only: /vindicate @user = lift ban & clear suspicion.');
      break;

    case 'reanimate':
      embed.setDescription('Admin only: /reanimate = removes the effects of vindicate clearing suspicion.');
      break;

    case 'snap':
      embed.setDescription('Admin only: /snap = delete all unconfirmed (limbo) game messages.');
      break;

    case 'thanos-snap':
      embed.setDescription('Admin only: /thanos-snap = end season, show top players, then reset all data.');
      break;

    case 'endgame':
      embed.setDescription('Admin only: /endgame = restore last season backup and announce restoration.');
      break;
  }

  await interaction.reply({ embeds: [embed] });
}
