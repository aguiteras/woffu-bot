const request = require("request");
const util = require("util");
const post = util.promisify(request.post);
const put = util.promisify(request.put);
const { applyTimeString } = require("./features/utils");
const jwt_decode = require("jwt-decode");
const { isToday, isAfter } = require("date-fns");
const cron = require("node-cron");

const WOFFU_BASE_URL = (process.env.WOFFU_BASE_URL || "https://app.woffu.com").replace(/\/+$/, "");

const generateSign = (UserId, SignIn, date, Time) => ({
  UserId,
  SignIn,
  SignStatus: 1,
  Time,
  ShortTrueTime: Time,
  TrueDate: applyTimeString(date, "09:00:00").toISOString(),
});
const generateAllDay = (UserId, date) => ({
  Comments: "",
  Date: date.toISOString(),
  Signs: [
    generateSign(UserId, true, date, "09:00:00"),
    generateSign(UserId, false, date, "13:00:00"),
    generateSign(UserId, true, date, "14:00:00"),
    generateSign(UserId, false, date, "18:00:00"),
  ],
  UserId,
});
const generateHalfDay = (UserId, date) => ({
  Comments: "",
  Date: date.toISOString(),
  Signs: [
    generateSign(UserId, true, date, "10:00:00"),
    generateSign(UserId, false, date, "14:00:00"),
  ],
  UserId,
});

const generateWorkDay = (UserId, date, { startAt8 = false } = {}) => {
  const dayDate = applyTimeString(date, "20:00:00");
  const day = dayDate.getDay();

  if (day === 0 || day === 6) {
    throw new Error("No work-day schedule defined for weekends");
  }

  let checkInTime;
  let checkOutTime;

  if (day >= 1 && day <= 4) {
    checkInTime = startAt8 ? "08:00:00" : "09:00:00";
    checkOutTime = startAt8 ? "17:30:00" : "18:30:00";
  } else if (day === 5) {
    checkInTime = "09:00:00";
    checkOutTime = "16:00:00";
  }

  return {
    Comments: "",
    Date: dayDate.toISOString(),
    Signs: [
      generateSign(UserId, true, dayDate, checkInTime),
      generateSign(UserId, false, dayDate, "13:00:00"),
      generateSign(UserId, true, dayDate, "14:00:00"),
      generateSign(UserId, false, dayDate, checkOutTime),
    ],
    UserId,
  };
};

// Legacy: Mon–Fri always 8h
// - startAt8=false: 09:00–13:00 / 14:00–18:00
// - startAt8=true : 08:00–13:00 / 14:00–17:00
const generateWorkDayLegacy = (UserId, date, { startAt8 = false } = {}) => {
  const dayDate = applyTimeString(date, "20:00:00");
  const day = dayDate.getDay(); // 0=Sun ... 6=Sat

  if (day === 0 || day === 6) {
    throw new Error("No work-day schedule defined for weekends");
  }

  const checkInTime = startAt8 ? "08:00:00" : "09:00:00";
  const checkOutTime = startAt8 ? "17:00:00" : "18:00:00";

  return {
    Comments: "",
    Date: dayDate.toISOString(),
    Signs: [
      generateSign(UserId, true,  dayDate, checkInTime),
      generateSign(UserId, false, dayDate, "13:00:00"),
      generateSign(UserId, true,  dayDate, "14:00:00"),
      generateSign(UserId, false, dayDate, checkOutTime),
    ],
    UserId,
  };
};


const headers = (token) => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  Authorization: `Bearer ${token}`,
});

async function consolidateWorkDay(token, payload) {
  const signs = payload.Signs.map((sign) => {
    const signDate = applyTimeString(new Date(payload.Date), sign.Time);

    return {
      Date: signDate.toISOString(),
      SignIn: sign.SignIn,
    };
  });

  const newPayload = {
    WorkingDay: payload.Date,
    UserId: payload.UserId,
    Signs: signs,
  };

  const res = await post(`${WOFFU_BASE_URL}/api/v1/signs/consolidation`, {
    headers: headers(token),
    json: newPayload,
  });

  if (res.statusCode >= 400) {
    let msg = `Woffu error ${res.statusCode}`;

    try {
      if (res.body && res.body.Message) {
        msg += `: ${res.body.Message}`;
      } else if (res.body) {
        msg += `: ${JSON.stringify(res.body)}`;
      }
    } catch (e) {}

    throw new Error(msg);
  }

  return res.body;
}

async function login(username, password) {
  const result = await post(
    `${WOFFU_BASE_URL}/api/svc/accounts/authorization/token`,
    {
      form: {
        grant_type: "password",
        username,
        password,
      },
      json: true,
    }
  );

  if (result.statusCode >= 400) {
    throw new Error(`Woffu login error ${result.statusCode}`);
  }

  const token =
    result.body?.accessToken ||
    result.body?.access_token;

  if (!token) {
    throw new Error("Woffu login succeeded but no access token was returned");
  }

  return token;
}

async function fillAllDay(db, token, date) {
  if (isToday(date)) {
    enqueueFill(db, token, date, true);
    return "scheduled";
  }

  const { UserId } = jwt_decode(token);
  await put(`${WOFFU_BASE_URL}/api/diaries/selfSigns`, {
    headers: headers(token),
    json: generateAllDay(UserId, date),
  });
}

async function fillHalfDay(db, token, date) {
  if (isToday(date)) {
    enqueueFill(db, token, date, false);
    return "scheduled";
  }

  const { UserId } = jwt_decode(token);
  await put(`${WOFFU_BASE_URL}/api/diaries/selfSigns`, {
    headers: headers(token),
    json: generateHalfDay(UserId, date),
  });
}

function modernSign(UserId, date, time, signIn) {
  const [hh, mm, ss] = time.split(":").map(Number);

  const signDate = new Date(date);
  signDate.setHours(hh, mm, ss || 0, 0);

  return {
    signId: 0,
    userId: UserId,
    date: signDate.toISOString(),
    trueDate: signDate.toISOString(),
    signIn,

    ip: null,
    latitude: null,
    longitude: null,
    outside: null,

    time,
    valueTime: time,
    shortTime: time,
    shortTrueTime: time,
    shortValueTime: time,
    utcTime: `${time} +0`,

    code: null,
    signType: 3,
    signStatus: 1,
    signEventId: null,
    deviceId: null,
    deviceType: 0,
    deleted: false,
    updatedOn: null,
    requestId: null,
    agreementEventId: null,
  };
}

function generateModernWorkDay(UserId, date, options = {}) {
  const {
    startAt8 = false,
    legacy = false,
  } = options;

  const d = new Date(date);
  const day = d.getDay();

  if (day === 0 || day === 6) {
    throw new Error("No work-day schedule defined for weekends");
  }

  let checkIn;
  let checkOut;

  if (legacy) {
    checkIn = startAt8 ? "08:00:00" : "09:00:00";
    checkOut = startAt8 ? "17:00:00" : "18:00:00";
  } else if (day >= 1 && day <= 4) {
    checkIn = startAt8 ? "08:00:00" : "09:00:00";
    checkOut = startAt8 ? "17:30:00" : "18:30:00";
  } else {
    // Friday
    checkIn = "09:00:00";
    checkOut = "16:00:00";
  }

  const in1 = modernSign(UserId, d, checkIn, true);
  const out1 = modernSign(UserId, d, "13:00:00", false);
  const in2 = modernSign(UserId, d, "14:00:00", true);
  const out2 = modernSign(UserId, d, checkOut, false);

  const dateString =
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`;

  return {
    date: dateString,
    comments: "",
    userId: UserId,

    slots: [
      {
        id: "slot-0",
        in: in1,
        out: out1,
        motive: null,
        totalMin: minutesBetween(checkIn, "13:00:00"),
      },
      {
        id: "slot-1",
        in: in2,
        out: out2,
        motive: null,
        totalMin: minutesBetween("14:00:00", checkOut),
      },
    ],
  };
}

function minutesBetween(start, end) {
  const toMinutes = (value) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };

  return toMinutes(end) - toMinutes(start);
}

async function putModernWorkDay(token, date, options = {}) {
  const { UserId } = jwt_decode(token);

  if (!UserId) {
    throw new Error("No UserId found in Woffu token");
  }

  const payload = generateModernWorkDay(
    UserId,
    date,
    options
  );

  const res = await put(
    `${WOFFU_BASE_URL}/api/svc/core/users/${UserId}/diarysummaries/workday/slots/self`,
    {
      headers: headers(token),
      json: payload,
    }
  );

  if (res.statusCode >= 400) {
    const body =
      typeof res.body === "string"
        ? res.body
        : JSON.stringify(res.body);

    throw new Error(
      `Woffu error ${res.statusCode}: ${body || "empty response"}`
    );
  }

  return true;
}

async function fillWorkDay(db, token, date, options = {}) {
  if (isToday(date)) {
    enqueueFill(db, token, date, true, {
      workDay: true,
      startAt8: !!options.startAt8,
    });

    return "scheduled";
  }

  return putModernWorkDay(token, date, {
    startAt8: !!options.startAt8,
    legacy: false,
  });
}

async function fillWorkRange(db, token, startDate, endDate, options = {}) {
  let current = new Date(startDate);
  const end = new Date(endDate);

  current.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  if (current > end) {
    throw new Error("startDate must be before or equal to endDate");
  }

  while (current <= end) {
    const day = current.getDay();

    if (day >= 1 && day <= 5) {
      const dateForCall = new Date(current);
      await fillWorkDay(db, token, dateForCall, options);
    }

    current.setDate(current.getDate() + 1);
  }
}

async function fillWorkDayLegacy(db, token, date, options = {}) {
  if (isToday(date)) {
    enqueueFill(db, token, date, true, {
      workDay: true,
      workDayMode: "legacy",
      startAt8: !!options.startAt8,
    });

    return "scheduled";
  }

  return putModernWorkDay(token, date, {
    startAt8: !!options.startAt8,
    legacy: true,
  });
}

async function fillWorkRangeLegacy(db, token, startDate, endDate, options = {}) {
  let current = new Date(startDate);
  const end = new Date(endDate);

  current.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  if (current > end) {
    throw new Error("startDate must be before or equal to endDate");
  }

  while (current <= end) {
    const day = current.getDay(); // 1–5 Mon–Fri

    if (day >= 1 && day <= 5) {
      const dateForCall = new Date(current);
      await fillWorkDayLegacy(db, token, dateForCall, options);
    }

    current.setDate(current.getDate() + 1);
  }
}

function enqueueFill(db, token, date, full, options = {}) {
  const {
    workDay = false,
    startAt8 = false,
    workDayMode = "new", // "new" or "legacy"
  } = options;

  const { exp } = jwt_decode(token);
  if (isAfter(Date.now() + 24 * 60 * 60 * 1000, exp * 1000)) {
    throw new Error("token will expire");
  }

  const scheduledFills = db.get("scheduledFills");
  if (scheduledFills.find({ token }).value()) {
    throw new Error("already scheduled");
  }

  scheduledFills.push({ token, date, full, workDay, startAt8, workDayMode }).write();
}

async function dailyFills(db) {
  const fills = db.get("scheduledFills").value();

  for (let k of fills) {
    try {
      if (k.workDay) {
        const mode = k.workDayMode || "new";
        if (mode === "legacy") {
          await fillWorkDayLegacy(db, k.token, new Date(k.date), { startAt8: k.startAt8 });
        } else {
          await fillWorkDay(db, k.token, new Date(k.date), { startAt8: k.startAt8 });
        }
      } 
      else if (k.full) {
        await fillAllDay(db, k.token, new Date(k.date));
      } else {
        await fillHalfDay(db, k.token, new Date(k.date));
      }
    } catch (ex) {
      console.log(ex);
    }
  }

  db.get("scheduledFills")
    .remove(() => true)
    .write();
}

const setupDailyFills = (db) => {
  cron.schedule("0 0 * * *", () => dailyFills(db));
};

module.exports = {
  login,
  setupDailyFills,
  fillAllDay,
  fillHalfDay,
  fillWorkDay,
  fillWorkRange,
  fillWorkDayLegacy,
  fillWorkRangeLegacy,
  _debug: {
    generateWorkDay,
    generateWorkDayLegacy,
    headers,
  },
};

