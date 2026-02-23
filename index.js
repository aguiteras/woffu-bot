const Koa = require("koa");
const app = new Koa();
const router = require("koa-router")();
const cors = require("koa-cors");
const bodyParser = require("koa-bodyparser");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const { WebClient } = require("@slack/web-api");
const { postDm } = require("./slack");

const { routes, processMessage } = require("./features");
const { prepareRegisterUrl } = require("./features/register");
const { setupReminders, processIM } = require("./features/reminders");
const intratime = require("./intratime");

const oauthToken = process.env.SLACK_TOKEN;
if (!oauthToken) {
  console.error("This server needs a slack token set in SLACK_TOKEN env variable");
  process.exit(1);
}

const slackWeb = new WebClient(oauthToken);

// Persist DB in /data (docker named volume)
const adapter = new FileSync("/data/db.json");
const db = low(adapter);
db.defaults({
  users: [],
  tokens: [],
  scheduledFills: [],
}).write();

setupReminders(db, slackWeb);
intratime.setupDailyFills(db);

router
  .get("/", async (ctx) => {
    ctx.body = "hello! You shouldn't be here :)";
  })
  .post("/", async (ctx) => {
    let body = ctx.request.body;
    if (body.payload) {
      body = JSON.parse(body.payload);
    }

    const { type, challenge, event } = body;

    switch (type) {
      case "url_verification":
        ctx.body = challenge;
        break;
      case "event_callback":
        ctx.body = "";
        processEvent(event);
        break;
      case "block_actions":
        ctx.body = "";
        processIM(body, db).catch(console.error);
        break;
      default:
        console.log(body);
    }
  });

routes(router, db, slackWeb);

app.use(cors()).use(bodyParser()).use(router.routes()).use(router.allowedMethods());

const port = parseInt(process.env.PORT || "8001", 10);
app.listen(port);

async function processEvent(event) {
  const { text, channel, user, bot_id, subtype, channel_type } = event;
  const insensitiveText = text && text.toLowerCase();

  // Ignore messages sent by bots (it could be us!)
  if (bot_id || subtype === "message_changed") return;

  // Some Slack events may not carry user/channel
  if (!user || !channel) return;

  // user = stable identifier (U...)
  // channel = conversation to reply to (D... for DM, C... for channels)
  const userId = user;

  const dbUser = db.get("users").find({ id: userId }).value();

  if (!dbUser) {
    const url = prepareRegisterUrl(userId, db);

    if (channel_type === "im") {
      // Reply in the same DM thread
      return slackWeb.chat.postMessage({
        text: `It seems like you haven't registered yet. Click here to register: ${url}`,
        channel,
      });
    }

    // If message came from a public channel, DM user instead of spamming channel
    return postDm(slackWeb, userId, {
      text: `It seems like you haven't registered yet. Click here to register: ${url}`,
    });
  }

  const msg =
    insensitiveText &&
    (await processMessage(insensitiveText, dbUser, {
      db,
      intratime,
      postMessage: (m) =>
        slackWeb.chat.postMessage({
          ...m,
          channel, // ALWAYS respond in the same conversation
        }),
    }));

  return slackWeb.chat.postMessage({
    ...(msg || { text: "Sorry, I didn't get that" }),
    channel,
  });
}

