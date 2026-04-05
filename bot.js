require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const axios = require('axios');
const fs = require('fs');

// ─── Storage ──────────────────────────────────────────────────────────────────
const DATA_FILE = './data.json';
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { users: {}, totalKm: 0 };
  return JSON.parse(fs.readFileSync(DATA_FILE));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

// ─── Register Slash Commands ──────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('linkstrava')
      .setDescription('Link your Strava account to the Discord bot')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
}

// ─── Handle Slash Commands ────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // /linkstrava
  if (interaction.commandName === 'linkstrava') {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const linkUrl = `${process.env.BASE_URL}/auth?discord_id=${userId}`;

    await interaction.reply({
      content:
        `Hey **${username}**! Click the link below to connect your Strava account:\n` +
        `🔗 ${linkUrl}\n\n` +
        `Once you authorize it, the bot will automatically post your bike rides in the server!`,
      ephemeral: true
    });
  }
});

client.once('ready', async () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(process.env.DISCORD_TOKEN);

// ─── Express Server ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/auth', (req, res) => {
  const discordId = req.query.discord_id;
  if (!discordId) return res.send('Missing discord_id.');

  const authUrl =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${process.env.STRAVA_CLIENT_ID}` +
    `&redirect_uri=${process.env.BASE_URL}/callback` +
    `&response_type=code` +
    `&scope=activity:read_all` +
    `&state=${discordId}`;

  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const { code, state: discordId } = req.query;

  try {
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });

    const { access_token, refresh_token, athlete } = response.data;
    const athleteName = `${athlete.firstname} ${athlete.lastname}`;

    const data = loadData();
    data.users[athlete.id] = {
      discordId,
      athleteName,
      access_token,
      refresh_token,
      stravaId: athlete.id,
    };
    saveData(data);

    await subscribeWebhook();

    res.send(`
      <h2>✅ Success!</h2>
      <p><strong>${athleteName}</strong> is now linked to Discord!</p>
      <p>You can close this tab. The bot will now post your cycling activities automatically.</p>
    `);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.send('❌ Something went wrong. Try again.');
  }
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
    console.log('✅ Strava webhook verified');
    res.json({ 'hub.challenge': challenge });
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const event = req.body;
  if (event.object_type !== 'activity' || event.aspect_type !== 'create') return;

  const stravaId = event.owner_id;
  const activityId = event.object_id;

  const data = loadData();
  const user = data.users[stravaId];
  if (!user) return;

  try {
    const accessToken = await getValidToken(user, stravaId, data);

    const actRes = await axios.get(
      `https://www.strava.com/api/v3/activities/${activityId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const activity = actRes.data;
    const type = activity.type;

    const bikeTypes = ['Ride', 'VirtualRide', 'EBikeRide', 'MountainBikeRide', 'GravelRide'];
    if (!bikeTypes.includes(type)) return;

    const km = (activity.distance / 1000).toFixed(2);
    const label = type === 'VirtualRide' ? 'indoor bike ride' : 'bike ride';

    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    await channel.send(
      `🚴 **${user.athleteName}** did a ${label} of **${km} km**!`
    );
  } catch (err) {
    console.error('Webhook error:', err.response?.data || err.message);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getValidToken(user, stravaId, data) {
  try {
    const res = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.refresh_token,
    });
    data.users[stravaId].access_token = res.data.access_token;
    data.users[stravaId].refresh_token = res.data.refresh_token;
    saveData(data);
    return res.data.access_token;
  } catch {
    return user.access_token;
  }
}

async function subscribeWebhook() {
  try {
    await axios.post('https://www.strava.com/api/v3/push_subscriptions', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      callback_url: `${process.env.BASE_URL}/webhook`,
      verify_token: process.env.STRAVA_VERIFY_TOKEN,
    });
    console.log('✅ Strava webhook subscribed');
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || '';
    if (!msg.includes('already')) {
      console.error('Webhook subscribe error:', err.response?.data || err.message);
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
