async function getImChannelId(slackWeb, userId) {
  const opened = await slackWeb.conversations.open({ users: userId });
  return opened.channel.id;
}

async function postDm(slackWeb, userId, message) {
  const channel = await getImChannelId(slackWeb, userId);
  return slackWeb.chat.postMessage({
    ...message,
    channel,
  });
}

module.exports = { getImChannelId, postDm };

