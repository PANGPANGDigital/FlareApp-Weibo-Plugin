type CookiePair = { name: string; value: string };
type StoredCredential = { cookies: CookiePair[]; profile: ProfileV1 };
type Topic = {
  id: string;
  name: string;
  signed: boolean;
  checkinUrl?: string;
};
type TopicResult = {
  name: string;
  status: "already" | "success" | "failed" | "unknown";
  message?: string;
};

const API_CONFIG_PATH = "/api/config";
const PROFILE_PATH = "/profile/info";
const FRIENDS_TIMELINE_PATH = "/feed/friends";
const TOPICS_PATH = "/api/container/getIndex?containerid=100803_-_followsuper";
const TOPICS_FALLBACK_PATH = "/api/container/getIndex?containerid=100803_-_page_my_follow_super";
const MAX_TOPIC_PAGES = 30;
const MAX_FAILURE_DETAILS = 10;
const MAX_TIMELINE_MEDIA = 12;

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "Referer": "https://m.weibo.cn/",
  "Accept": "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  "MWeibo-Pwa": "1",
};

defineFlareSocialPlugin({
  detector: {
    async detect(request, context) {
      const origin = request.origin || context.origin || "https://m.weibo.cn";
      const hostMatch = origin.match(/^https?:\/\/([^/:]+)/i);
      const host = hostMatch ? hostMatch[1].toLowerCase() : "";

      const isWeibo =
        host === "m.weibo.cn" ||
        host.endsWith(".weibo.cn") ||
        host === "weibo.cn" ||
        host === "weibo.com" ||
        host.endsWith(".weibo.com");

      if (!isWeibo) {
        return { match: "none", canonicalOrigin: origin };
      }

      try {
        const response = await flare.http.request({
          method: "GET",
          url: origin + API_CONFIG_PATH,
          headers: DEFAULT_HEADERS,
        });

        if (response.status === 200) {
          const body = JSON.parse(response.body);
          if (body && (body.ok === 1 || body.data)) {
            return {
              match: "exact",
              canonicalOrigin: "https://m.weibo.cn",
              software: "Weibo Enhance",
              instance: {
                domain: "m.weibo.cn",
                title: "Weibo Enhance",
                description: "微博增强版 (支持超话自动签到)",
              },
            };
          }
        }
      } catch {
        if (host === "m.weibo.cn") {
          return {
            match: "exact",
            canonicalOrigin: "https://m.weibo.cn",
            software: "Weibo Enhance",
            instance: {
              domain: "m.weibo.cn",
              title: "Weibo Enhance",
              description: "微博增强版 (支持超话自动签到)",
            },
          };
        }
      }

      return {
        match: "none",
        canonicalOrigin: origin,
      };
    },
  },

  login: {
    browser: {
      async begin(_request, context) {
        return { type: "webCookie", startUrl: context.origin + "/" };
      },
      async check(request, context) {
        const probeUrl = context.origin + API_CONFIG_PATH;
        const cookieNames = ["SUB", "SUBP", "_T_WM", "MLOGIN", "ALF", "XSRF-TOKEN"];
        const cookieMap = new Map<string, string>();
        for (const cookie of request.cookies.cookies) {
          if (cookieNames.includes(cookie.name) && cookie.value) {
            cookieMap.set(cookie.name, cookie.value);
          }
        }
        if (!cookieMap.has("SUB") || !cookieMap.get("SUB")) {
          return { type: "pending" };
        }
        const cookies: CookiePair[] = Array.from(cookieMap.entries()).map(([name, value]) => ({ name, value }));

        const config = await requestJson(probeUrl, context, cookies, {}, true, true);
        if (!config || !isLoggedIn(config)) return { type: "pending" };

        const configData = isRecord(config.data) ? config.data : {};

        let user: Record<string, unknown> | null = null;
        if (isRecord(configData.user)) {
          user = configData.user;
        } else if (configData.uid) {
          user = {
            id: configData.uid,
            screen_name: configData.screen_name || String(configData.uid),
          };
        }

        if (!user || !user.screen_name) {
          try {
            const profileResponse = await requestJson(
              context.origin + PROFILE_PATH,
              context,
              cookies,
              {},
              true,
              true,
            );
            if (profileResponse && isRecord(profileResponse.data) && isRecord(profileResponse.data.user)) {
              user = profileResponse.data.user;
            }
          } catch {
            // profile/info is optional
          }
        }

        if (!user) {
          return { type: "pending" };
        }

        const profile = mapProfile(user, context);
        const credential: StoredCredential = { cookies, profile };

        return {
          type: "success",
          value: {
            accountId: profile.key.id,
            origin: context.origin,
            credential: credential as unknown as JsonValue,
            profile,
            capabilities: { "flare.datasource.timeline/v1": ["page"] },
          },
        };
      },
    },
  },
  capabilities: {
    timeline: {
      async page(request, context) {
        if (request.timelineId && request.timelineId !== "checkin" && request.timelineId !== "friends") {
          fail("Unsupported", "Unknown timeline");
        }
        if (request.page.direction !== "refresh" && request.page.direction !== "older") {
          return { items: [], endReached: true };
        }

        const credential = await readCredential();
        const items: TimelineItemV1[] = [];

        const isTopOrRefresh =
          request.page.direction === "refresh" ||
          !request.page.cursor;

        if (isTopOrRefresh) {
          const results: TopicResult[] = [];
          let truncated = false;

          try {
            const topicPage = await fetchFollowedTopics(context, credential.cookies);
            results.push(...topicPage.results);
            truncated = topicPage.truncated;

            for (const topic of topicPage.toCheck) {
              results.push(await checkInTopic(topic, topicPage.xsrfToken, context, credential.cookies));
            }
          } catch (error) {
            if (isAuthenticationError(error)) throw error;
            const errorMsg =
              error && typeof error === "object" && "message" in error
                ? String((error as any).message?.value || (error as any).message)
                : "";
            results.push({
              name: "超话列表",
              status: "failed",
              message: errorMsg || "读取签到状态失败；未提交签到，请稍后刷新重试。",
            });
          }

          items.push(await makeSummaryPost(results, truncated, credential.profile, context));
        }

        const feedPage = await fetchFriendsTimeline(
          context,
          credential.cookies,
          request.page.direction === "older" ? request.page.cursor : undefined,
        );
        items.push(...feedPage.items);

        return {
          items,
          endReached: !feedPage.olderCursor,
          ...(feedPage.olderCursor ? { olderCursor: feedPage.olderCursor } : {}),
        };
      },
    },
  },
});

async function fetchFollowedTopics(
  context: PluginInvocationContextV1,
  cookies: CookiePair[],
): Promise<{ results: TopicResult[]; toCheck: Topic[]; xsrfToken: string; truncated: boolean }> {
  const config = await requestJson(context.origin + API_CONFIG_PATH, context, cookies);
  if (!config || !isLoggedIn(config)) {
    fail("AuthenticationRequired", "微博登录状态已失效，请重新登录。");
  }
  const configData = isRecord(config.data) ? config.data : {};
  const xsrfToken = typeof configData.st === "string" ? configData.st : "";

  const results: TopicResult[] = [];
  const toCheck: Topic[] = [];
  const seen = new Set<string>();
  let sinceId = "";
  let truncated = false;

  for (let page = 0; page < MAX_TOPIC_PAGES; page++) {
    const url = context.origin + TOPICS_PATH +
      (sinceId ? "&since_id=" + encodeURIComponent(sinceId) : "");
    const response = await requestJson(url, context, cookies, {}, false, true);
    if (!response || !isOkResponse(response.ok) || !hasCards(response)) {
      if (page === 0) {
        const fallbackUrl = context.origin + TOPICS_FALLBACK_PATH;
        const fallbackResp = await requestJson(fallbackUrl, context, cookies, {}, false, true);
        if (fallbackResp && isOkResponse(fallbackResp.ok)) {
          parseTopicCards(fallbackResp, seen, results, toCheck, context);
        }
      }
      break;
    }

    const data = isRecord(response.data) ? response.data : {};
    const added = parseTopicCards(response, seen, results, toCheck, context);

    const info = isRecord(data.cardlistInfo) ? data.cardlistInfo : {};
    const next = typeof info.since_id === "string" ? info.since_id : "";
    if (!next || next === sinceId || added === 0) break;
    sinceId = next;
    if (page === MAX_TOPIC_PAGES - 1) truncated = true;
  }

  return { results, toCheck, xsrfToken, truncated };
}

function hasCards(response: Record<string, unknown>): boolean {
  const data = isRecord(response.data) ? response.data : {};
  return Array.isArray(data.cards) && data.cards.length > 0;
}

function parseTopicCards(
  response: Record<string, unknown>,
  seen: Set<string>,
  results: TopicResult[],
  toCheck: Topic[],
  context: PluginInvocationContextV1,
): number {
  const data = isRecord(response.data) ? response.data : {};
  const cards = Array.isArray(data.cards) ? data.cards : [];
  let added = 0;

  for (const cardValue of cards) {
    if (!isRecord(cardValue)) continue;
    const entries = Array.isArray(cardValue.card_group) ? cardValue.card_group : [cardValue];
    for (const entryValue of entries) {
      if (!isRecord(entryValue)) continue;
      const name =
        (typeof entryValue.title_sub === "string" && entryValue.title_sub.trim()) ||
        (typeof entryValue.title === "string" && entryValue.title.trim()) ||
        (typeof entryValue.card_title === "string" && entryValue.card_title.trim()) ||
        (typeof entryValue.desc1 === "string" && entryValue.desc1.trim()) ||
        "";
      if (!name) continue;

      const button = Array.isArray(entryValue.buttons) && entryValue.buttons.length
        ? (isRecord(entryValue.buttons[0]) ? entryValue.buttons[0] : {})
        : (isRecord(entryValue.button) ? entryValue.button : {});
      const buttonName = typeof button.name === "string" ? button.name : "";
      const scheme = typeof button.scheme === "string" ? button.scheme : (typeof entryValue.scheme === "string" ? entryValue.scheme : "");

      const id = topicId(scheme) || (typeof entryValue.itemid === "string" ? entryValue.itemid : name);
      if (seen.has(id)) continue;
      seen.add(id);
      added++;

      const isSigned = buttonName.includes("已签") ||
        buttonName.includes("已簽") ||
        buttonName.includes("今日已签") ||
        buttonName.includes("今日已簽");
      const isCheckin = buttonName.includes("签到") || buttonName.includes("簽到");

      if (isSigned) {
        results.push({ name, status: "already" });
      } else if (isCheckin && scheme) {
        const checkinUrl = resolveCheckinUrl(scheme, context);
        if (checkinUrl) {
          toCheck.push({ name, id, signed: false, checkinUrl });
        } else {
          results.push({ name, status: "unknown", message: "签到地址无法识别" });
        }
      } else {
        results.push({ name, status: "unknown", message: "微博未提供可用签到入口" });
      }
    }
  }
  return added;
}

function resolveCheckinUrl(scheme: string, context: PluginInvocationContextV1): string | undefined {
  if (!scheme || typeof scheme !== "string") return undefined;
  const trimmed = scheme.trim();

  if (trimmed.startsWith("/")) {
    return context.origin + trimmed;
  }
  if (trimmed.startsWith(context.origin + "/")) {
    return trimmed;
  }
  if (trimmed.startsWith("http://m.weibo.cn/")) {
    return "https://m.weibo.cn/" + trimmed.slice("http://m.weibo.cn/".length);
  }

  const match = /[?&](?:pageid|containerid)=([0-9a-zA-Z_-]+)/.exec(trimmed) ||
    /containerid=([0-9a-zA-Z_-]+)/.exec(trimmed);
  if (match) {
    return `${context.origin}/api/container/getIndex?containerid=${encodeURIComponent(match[1])}_-_checkin`;
  }

  return undefined;
}

async function checkInTopic(
  topic: Topic,
  xsrfToken: string,
  context: PluginInvocationContextV1,
  cookies: CookiePair[],
): Promise<TopicResult> {
  if (!topic.checkinUrl) {
    return { name: topic.name, status: "failed", message: "缺少有效签到地址。" };
  }

  try {
    let url = topic.checkinUrl;
    if (xsrfToken && !/[?&]st=/.test(url)) {
      url += (url.includes("?") ? "&" : "?") + "st=" + encodeURIComponent(xsrfToken);
    }
    const headers: Record<string, string> = {};
    if (xsrfToken) {
      headers["x-xsrf-token"] = xsrfToken;
    }

    const response = await requestJson(url, context, cookies, headers, true, true);
    if (!response) {
      return { name: topic.name, status: "failed", message: "微博未返回签到结果。" };
    }

    const message = extractMessage(response);
    const code = typeof response.code === "number" ? response.code : undefined;
    const ok = isOkResponse(response.ok) || code === 100000 || response.result === 1 || response.result === "1";

    if (ok) {
      if (message.includes("已签") || message.includes("已簽")) {
        return { name: topic.name, status: "already", message };
      }
      return { name: topic.name, status: "success", message: message || "签到成功" };
    }
    if (message.includes("已签") || message.includes("已簽") || code === 382004) {
      return { name: topic.name, status: "already", message: message || "今日已签到" };
    }
    return {
      name: topic.name,
      status: "failed",
      message: safeRemoteMessage(message || (typeof response.msg === "string" ? response.msg : "")),
    };
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    return { name: topic.name, status: "failed", message: "签到请求失败或被风控。" };
  }
}

async function fetchFriendsTimeline(
  context: PluginInvocationContextV1,
  cookies: CookiePair[],
  cursor?: string,
): Promise<{ items: TimelineItemV1[]; olderCursor?: string }> {
  const url = context.origin + FRIENDS_TIMELINE_PATH +
    (cursor ? "?max_id=" + encodeURIComponent(cursor) : "");
  let response: Record<string, unknown> | null = null;
  try {
    response = await requestJson(url, context, cookies, {}, false, true);
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    return { items: [] };
  }
  if (!response || !isOkResponse(response.ok)) {
    return { items: [] };
  }

  const data = isRecord(response.data) ? response.data : {};
  if (!Array.isArray(data.statuses)) {
    return { items: [] };
  }

  const items = data.statuses
    .map((status) => mapTimelineStatus(status, context))
    .filter((item): item is TimelineItemV1 => item !== undefined);
  const rawCursor = data.next_cursor_str ?? data.next_cursor;
  const olderCursor = optionalScalarText(rawCursor);

  return {
    items,
    ...(olderCursor && olderCursor !== cursor ? { olderCursor } : {}),
  };
}

function mapTimelineStatus(value: unknown, context: PluginInvocationContextV1): TimelineItemV1 | undefined {
  if (!isRecord(value)) return undefined;
  const post = mapTimelinePost(value, context);
  if (!post) return undefined;

  const retweetedStatus = isRecord(value.retweeted_status)
    ? mapTimelinePost(value.retweeted_status, context)
    : undefined;
  return {
    type: "post",
    post,
    ...(retweetedStatus ? { presentation: { repost: retweetedStatus } } : {}),
  };
}

function mapTimelinePost(value: Record<string, unknown>, context: PluginInvocationContextV1): PostV1 | undefined {
  const id = optionalScalarText(value.idstr ?? value.id ?? value.mid);
  if (!id) return undefined;

  const host = accountHost(context);
  const statusText = optionalScalarText(value.raw_text) || htmlToPlainText(optionalScalarText(value.text) || "");
  const user = isRecord(value.user) ? mapTimelineProfile(value.user, context) : undefined;
  const post: PostV1 = {
    key: { id, host },
    createdAt: parseWeiboDate(optionalScalarText(value.created_at)),
    content: { format: "plain", value: statusText || "（微博内容为空）" },
    detailType: "link",
    url: context.origin + "/detail/" + encodeURIComponent(id),
    ...(user ? { author: user } : {}),
  };

  const media = mapStatusImages(value, id);
  if (media.length) post.media = media;

  const repliesCount = optionalNonnegativeNumber(value.comments_count);
  const repostsCount = optionalNonnegativeNumber(value.reposts_count);
  const favouritesCount = optionalNonnegativeNumber(value.attitudes_count);
  if (repliesCount !== undefined) post.repliesCount = repliesCount;
  if (repostsCount !== undefined) post.repostsCount = repostsCount;
  if (favouritesCount !== undefined) post.favouritesCount = favouritesCount;

  return post;
}

function mapTimelineProfile(user: Record<string, unknown>, context: PluginInvocationContextV1): ProfileV1 | undefined {
  const id = optionalScalarText(user.idstr ?? user.id);
  const handle = optionalScalarText(user.screen_name);
  if (!id || !handle) return undefined;

  const avatarUrl = safeWeiboMediaUrl(user.avatar_hd ?? user.profile_image_url);
  return {
    key: { id, host: accountHost(context) },
    handle,
    displayName: handle,
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function mapStatusImages(status: Record<string, unknown>, statusId: string): MediaV1[] {
  const rawPics = status.pics;
  const pics = Array.isArray(rawPics)
    ? rawPics
    : isRecord(rawPics)
      ? Object.values(rawPics)
      : [];
  const media: MediaV1[] = [];

  for (const [index, rawPic] of pics.entries()) {
    if (!isRecord(rawPic)) continue;
    const large = isRecord(rawPic.large) ? rawPic.large : {};
    const rawUrl = optionalScalarText(large.url) || optionalScalarText(rawPic.url);
    const url = safeWeiboMediaUrl(rawUrl);
    if (!url) continue;

    const previewUrl = safeWeiboMediaUrl(optionalScalarText(rawPic.url)) || url;
    const geo = isRecord(large.geo) ? large.geo : (isRecord(rawPic.geo) ? rawPic.geo : {});
    const width = optionalPositiveNumber(geo.width);
    const height = optionalPositiveNumber(geo.height);
    const picId = optionalScalarText(rawPic.pid) || `${statusId}-image-${index}`;
    media.push({
      id: picId,
      type: "image",
      url,
      previewUrl,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
    if (media.length >= MAX_TIMELINE_MEDIA) break;
  }

  if (!media.length) {
    const fallbackUrl = safeWeiboMediaUrl(status.original_pic ?? status.bmiddle_pic ?? status.thumbnail_pic);
    if (fallbackUrl) {
      media.push({
        id: `${statusId}-image-0`,
        type: "image",
        url: fallbackUrl,
        previewUrl: safeWeiboMediaUrl(status.thumbnail_pic) || fallbackUrl,
      });
    }
  }

  return media;
}

function safeWeiboMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const candidate = value.trim().startsWith("http://")
    ? "https://" + value.trim().slice("http://".length)
    : value.trim();
  const match = /^https:\/\/([^/]+)\//i.exec(candidate);
  if (!match) return undefined;
  const host = match[1].toLowerCase();
  const allowed = host === "sinaimg.cn" || host.endsWith(".sinaimg.cn") || host.endsWith(".weibocdn.com");
  return allowed ? candidate : undefined;
}

function parseWeiboDate(value: string | undefined): string {
  const pattern = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})\s+(\d{4})$/;
  const match = pattern.exec(value || "");
  if (match) {
    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const month = months[match[1]];
    if (month !== undefined) {
      const localTime = Date.UTC(
        Number(match[9]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]),
      );
      const offsetMinutes = (Number(match[7]) * 60 + Number(match[8])) * (match[6] === "+" ? 1 : -1);
      return new Date(localTime - offsetMinutes * 60_000).toISOString();
    }
  }

  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function htmlToPlainText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .trim(),
  );
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

async function makeSummaryPost(
  results: TopicResult[],
  truncated: boolean,
  profile: ProfileV1,
  context: PluginInvocationContextV1,
): Promise<TimelineItemV1> {
  const already = results.filter((item) => item.status === "already").length;
  const success = results.filter((item) => item.status === "success").length;
  const failed = results.filter((item) => item.status === "failed").length;
  const unknown = results.filter((item) => item.status === "unknown").length;
  const checked = already + success + failed + unknown;

  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

  const lines = [
    `【超话签到通知 · ${timeStr}】`,
    `关注超话：共 ${checked} 个（已签 ${already}，本次成功 ${success}，失败 ${failed}）`,
  ];
  if (unknown > 0) lines.push(`ℹ️ 另有 ${unknown} 个超话未识别到签到入口。`);
  if (truncated) lines.push(`⚠️ 超话列表已达 ${MAX_TOPIC_PAGES} 页限制。`);

  const successes = results.filter((item) => item.status === "success").slice(0, 5);
  if (successes.length) {
    lines.push("✅ 本次签到成功：" + successes.map((item) => item.name).join("、"));
  }

  const failures = results.filter((item) => item.status === "failed").slice(0, MAX_FAILURE_DETAILS);
  if (failures.length) {
    lines.push("❌ 签到失败：" + failures.map((item) => `${item.name}（${item.message || "请求失败"}）`).join("；"));
  }

  if (checked === 0) {
    lines.push("（未扫描到关注的超话，请确认微博账号已关注超话）");
  }

  return {
    type: "post",
    post: {
      key: { id: "checkin-summary-" + (await flare.crypto.uuid()), host: accountHost(context) },
      createdAt: now.toISOString(),
      author: profile,
      content: { format: "plain", value: lines.join("\n") },
      detailType: "link",
      url: context.origin + "/",
    },
  };
}

async function requestJson(
  url: string,
  context: PluginInvocationContextV1,
  cookies: CookiePair[],
  extraHeaders: Record<string, string> = {},
  allowUnauthorized = false,
  allowNotFound = false,
): Promise<Record<string, unknown> | null> {
  if (!isSameOrigin(url, context.origin)) {
    fail("Unsupported", "微博接口跳转到了所选账号站点之外，已停止请求。");
  }

  let response: HttpResponseV1;
  try {
    response = await flare.http.request({
      method: "GET",
      url,
      cookies,
      headers: {
        ...DEFAULT_HEADERS,
        "Referer": context.origin + "/",
        ...extraHeaders,
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "host.unavailable") {
      fail("Network", "Flare 无法连接微博接口。");
    }
    throw error;
  }

  if (response.status === 401 && allowUnauthorized) return null;
  if (response.status === 404 && allowNotFound) return null;
  if (response.status === 401 || response.status === 403) {
    fail("AuthenticationRequired", "微博登录状态已失效或请求未获授权。");
  }
  if (response.status < 200 || response.status >= 300) {
    fail("Remote", "微博接口返回 HTTP " + response.status + "。");
  }

  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    fail("InvalidResponse", "微博接口没有返回有效 JSON。");
  }
  return requiredObject(value);
}

async function readCredential(): Promise<StoredCredential> {
  const value = await flare.credential.read();
  if (!isRecord(value)) {
    fail("AuthenticationRequired", "微博登录信息无效，请重新登录。");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.cookies) || !isRecord(record.profile)) {
    fail("AuthenticationRequired", "微博登录信息无效，请重新登录。");
  }
  const cookies = record.cookies.filter(isCookiePair);
  if (!cookies.some((cookie) => cookie.name === "SUB" && cookie.value)) {
    fail("AuthenticationRequired", "微博登录 Cookie 已失效，请重新登录。");
  }
  return { cookies, profile: record.profile as unknown as ProfileV1 };
}

function mapProfile(user: Record<string, unknown>, context: PluginInvocationContextV1): ProfileV1 {
  const id = requiredScalarText(user.idstr ?? user.id);
  const handle = requiredScalarText(user.screen_name);
  const avatarUrl = safeWeiboMediaUrl(user.avatar_hd ?? user.profile_image_url);
  return {
    key: { id, host: accountHost(context) },
    handle,
    displayName: handle,
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function isLoggedIn(value: Record<string, unknown>): boolean {
  const data = isRecord(value.data) ? value.data : {};
  return data.login === true || data.login === 1 || data.login === "1";
}

function isOkResponse(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function topicId(scheme: string): string {
  const match = /containerid=([0-9a-zA-Z_-]+)/.exec(scheme);
  return match ? match[1] : "";
}

function isSameOrigin(url: string, origin: string): boolean {
  return url === origin || url.startsWith(origin + "/");
}

function extractMessage(value: Record<string, unknown>): string {
  const data = isRecord(value.data) ? value.data : {};
  if (typeof data.msg === "string") return data.msg;
  const button = isRecord(data.button) ? data.button : {};
  if (typeof button.name === "string") return button.name;
  return typeof value.msg === "string" ? value.msg : "";
}

function safeRemoteMessage(value: string): string {
  const message = value.trim().replace(/[\r\n\t]+/g, " ").slice(0, 100);
  return message || "微博未确认签到结果。";
}

function isAuthenticationError(error: unknown): boolean {
  return isRecord(error) && error.code === "AuthenticationRequired";
}

function isCookiePair(value: unknown): value is CookiePair {
  return isRecord(value) && typeof value.name === "string" && typeof value.value === "string";
}

function accountHost(context: PluginInvocationContextV1): string {
  return context.origin.slice("https://".length);
}

function requiredScalarText(value: unknown): string {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    fail("InvalidResponse", "微博没有返回有效账号资料。");
  }
  return String(value);
}

function optionalScalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionalNonnegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : (typeof value === "string" ? Number(value) : NaN);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const number = optionalNonnegativeNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail("InvalidResponse", "微博接口返回了非对象数据。");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(code: PluginErrorCodeV1, message: string): never {
  throw flare.error({ code, message: { value: message } });
}
