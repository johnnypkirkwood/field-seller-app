// Slack web API wrapper — lazy WebClient init, per-ID channel info
// resolver, user-info cache. Channels are configured by ID
// (SLACK_CHANNELS=C123...,C456...), not by name.
const { WebClient } = require('@slack/web-api');

let client = null;
let channelInfoCache = new Map(); // channelId -> { id, name, is_private }
let userCache = new Map();        // userId -> display name

function getClient() {
  if (!client) {
    const token = process.env.SLACK_USER_TOKEN;
    if (!token) {
      throw new Error('SLACK_USER_TOKEN not configured');
    }
    client = new WebClient(token);
  }
  return client;
}

// Configured channel IDs from SLACK_CHANNELS (comma-separated).
// Treat the env value as a list of channel IDs verbatim — no name
// resolution, no normalization. IDs are stable; names are not.
function getConfiguredChannelIds() {
  return (process.env.SLACK_CHANNELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Resolve a channel ID to its display info. One conversations.info
// call per ID, cached after first hit. On error (revoked access,
// archived channel, etc.) returns a safe fallback object so callers
// don't have to branch.
async function resolveChannelInfo(channelId) {
  if (channelInfoCache.has(channelId)) {
    return channelInfoCache.get(channelId);
  }
  const c = getClient();
  try {
    const res = await c.conversations.info({ channel: channelId });
    const info = {
      id: res.channel.id,
      name: res.channel.name || channelId,
      is_private: !!res.channel.is_private,
    };
    channelInfoCache.set(channelId, info);
    return info;
  } catch (err) {
    const fallback = { id: channelId, name: channelId, error: err.message };
    channelInfoCache.set(channelId, fallback);
    return fallback;
  }
}

// Resolve a userId to a display name. Cached. Falls back to the userId
// string if the lookup fails (deleted user, no permission, etc.).
async function resolveUser(userId) {
  if (!userId) return '';
  if (userCache.has(userId)) return userCache.get(userId);
  const c = getClient();
  try {
    const res = await c.users.info({ user: userId });
    const name = res.user.real_name || res.user.name || userId;
    userCache.set(userId, name);
    return name;
  } catch (err) {
    return userId;
  }
}

module.exports = {
  getClient,
  getConfiguredChannelIds,
  resolveChannelInfo,
  resolveUser,
};
