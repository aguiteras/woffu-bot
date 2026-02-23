const { isWeekend, format } = require("date-fns");
const { utcToZonedTime } = require("date-fns-tz");
const cron = require("node-cron");
const request = require("request");
const util = require("util");
const post = util.promisify(request.post);

const { fillWorkDay } = require("../intratime");
const { prepareRegisterUrl } = require("./register");
const { postDm } = require("../slack");

const timeRegex = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/;

async function setupReminderCommand(text, user, { db }) {
  const query = text.split(" ");
  if (query[0] === "remind" && timeRegex.test(query[1])) {
    const time = query[1].split(":");
    const timeString = time.slice(0, 2).join(":");

    db.get("users")
      .find(user)
      .assign({
        reminder: timeString,
      })
      .write();

    return {
      text: `Sure! I'll remind you about woffu every day at ${timeString}`,
    };
  }
}

async function stopReminderCommand(text, user, { db }) {
  if (text.startsWith("remind stop")) {
    db.get("users")
      .find(user)
      .assign({
        reminder: undefined,
      })
      .write();

    return {
      text: `Alright, I won't remind you about woffu anymore`,
    };
  }
}

async function sendReminders(db, slackWeb) {
  const nowUtc = new Date();
  const nowLocal = utcToZonedTime(nowUtc, "Europe/Madrid");

  const todayKey = format(nowLocal, "yyyy-MM-dd");
  const nowHm = format(nowLocal, "HH:mm");

  // Skip weekends in local time
  if (isWeekend(nowLocal)) return;

  const users = db
    .get("users")
    .filter((u) => {
      if (!u.reminder) return false;

      // Only fire at EXACT HH:MM
      if (u.reminder !== nowHm) return false;

      // Once-per-day guard
      if (u.lastReminderSent === todayKey) return false;

      return true;
    })
    .value();

  for (let u of users) {
    const userId = u.id;

    // mark as sent first to prevent duplicates
    db.get("users")
      .find({ id: userId })
      .assign({ lastReminderSent: todayKey })
      .write();

    await postDm(slackWeb, userId, {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Hey! Reminder time. Do you want me to fill the *work day for today*?`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Fill work day" },
              value: "FillWorkDay",
              action_id: "reminder-fill-workday",
            },
          ],
        },
      ],
      text: "Woffu reminder",
    });
  }
}

async function processIM(event, db) {
  const { actions, response_url } = event;
  const action = actions[0];

  const updateMessage = (text) =>
    post(response_url, {
      body: {
        replace_original: "true",
        text,
      },
      json: true,
    });

  // user id is U..., not channel id
  const user = db.get("users").find({ id: event.user.id }).value();

  if (!user) {
    const url = prepareRegisterUrl(event.user.id, db);
    return updateMessage(
      `It seems like you haven't registered yet. Click here to register: ${url}`
    );
  }

  if (action.action_id === "reminder-fill-workday") {
    try {
      const result = await fillWorkDay(db, user.token, new Date(), { startAt8: false });

      if (result === "scheduled") {
        return updateMessage(
          "As I can't fill future hours, I've scheduled the work day for tonight."
        );
      }

      return updateMessage("Done! Filled the work day for today.");
    } catch (ex) {
      console.log(ex);

      if (ex.message === "token will expire") {
        const url = prepareRegisterUrl(user.id, db);
        return updateMessage(
          `⚠️⚠️⚠️ I can't schedule to fill your hours tonight because your token would expire ⚠️⚠️⚠️ \n\nPlease, use this url to refresh your token ${url}, and then run the "fill work day" command`
        );
      }

      return updateMessage(`Sorry I couldn't do it: ${ex.message}`);
    }
  }

  return updateMessage("OK");
}

const setupReminders = (db, slackWeb) => {
  // Run every minute; logic ensures it only fires at exact HH:MM once/day.
  cron.schedule("* * * * *", () => sendReminders(db, slackWeb));
};

module.exports = {
  setupReminders,
  commands: [setupReminderCommand, stopReminderCommand],
  processIM,
  help: [
    "`remind HH:MM`: Set up a daily reminder for woffu",
    "`remind stop`: Stop reminding please",
  ],
};

