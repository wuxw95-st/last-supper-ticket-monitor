const EVENT_URL =
  "https://cenacolovinciano.vivaticket.it/en/event/cenacolo-vinciano/151991";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

async function checkTickets() {
  const pageResponse = await fetch(EVENT_URL, {
    headers: HEADERS,
    redirect: "follow",
  });
  const html = await pageResponse.text();
  const blocked =
    /Incapsula|_Incapsula_Resource|Queue-it|queueerrorpage|verify you are human/i.test(
      html,
    );

  if (blocked || html.length < 1000) {
    return {
      ok: false,
      available: false,
      reason: "Vivaticket blocked the Cloudflare request",
      httpStatus: pageResponse.status,
      finalUrl: pageResponse.url,
      responseLength: html.length,
      checkedAt: new Date().toISOString(),
    };
  }

  const target = html.match(
    /eventi\['151991'\]\.push\(new Array\s*\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*new Date\s*\(\s*2026\s*,\s*\(10-1\)\s*,\s*0?6\s*\)\s*,\s*'(\d+)'\s*,\s*(\d+)\s*,\s*'(\d+)'\s*\)\s*\)/,
  );
  if (!target) {
    return {
      ok: false,
      available: false,
      reason: "Target date data was not found",
      checkedAt: new Date().toISOString(),
    };
  }

  const [, tcode, pcode, calendarSeats, , filterSeats] = target;
  const body = new URLSearchParams({
    ajax: "1",
    cal: "1",
    tcode,
    pcode,
    "seat-filter": "2",
  });

  const timetableResponse = await fetch(
    "https://cenacolovinciano.vivaticket.it/eventoWidgetTlite.php",
    {
      method: "POST",
      headers: {
        ...HEADERS,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Referer: EVENT_URL,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
      redirect: "follow",
    },
  );

  const timetableText = await timetableResponse.text();
  if (/Incapsula|Queue-it|<html/i.test(timetableText)) {
    return {
      ok: false,
      available: false,
      reason: "Timetable request was blocked",
      calendarSeats: Number(calendarSeats),
      filterSeats: Number(filterSeats),
      checkedAt: new Date().toISOString(),
    };
  }

  let slots;
  try {
    slots = JSON.parse(timetableText.trim());
  } catch {
    return {
      ok: false,
      available: false,
      reason: "Timetable returned an unexpected format",
      checkedAt: new Date().toISOString(),
    };
  }

  const eligibleTimes = slots
    .filter(
      (slot) =>
        Number(slot.d) >= 2 &&
        /^\d{2}:\d{2}$/.test(slot.ora) &&
        slot.ora < "16:30",
    )
    .map((slot) => slot.ora);

  return {
    ok: true,
    available: eligibleTimes.length > 0,
    date: "2026-10-06",
    minimumSeats: 2,
    before: "16:30",
    eligibleTimes,
    checkedAt: new Date().toISOString(),
  };
}

async function sendBark(barkUrl, result) {
  const endpoint = barkUrl.replace(/\/+$/, "");
  const body = {
    title: "最后的晚餐发现余票",
    body:
      "2026-10-06 可订时间：" +
      result.eligibleTimes.join("、") +
      "。请选择2张全价票（每张€15），不要附加票。",
    url: EVENT_URL,
    url_title: "立即打开官方购票页",
    group: "last-supper-tickets",
    sound: "alarm",
    level: "timeSensitive",
    call: "1",
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error("Bark notification failed: HTTP " + response.status);
  }
}

async function runScheduled(env) {
  const result = await checkTickets();
  console.log(JSON.stringify(result));
  if (!result.ok || !result.available) return;

  if (!env.BARK_URL) {
    console.error("BARK_URL secret is not configured");
    return;
  }

  const cache = caches.default;
  const alertKey = new Request("https://last-supper-monitor.invalid/alert-state");
  if (await cache.match(alertKey)) return;

  await sendBark(env.BARK_URL, result);
  await cache.put(
    alertKey,
    new Response(result.checkedAt, {
      headers: { "Cache-Control": "max-age=600" },
    }),
  );
}

export default {
  async fetch() {
    return Response.json(await checkTickets(), {
      headers: { "Cache-Control": "no-store" },
    });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};