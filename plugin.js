"use strict";
(() => {
  // src/plugin.ts
  var API_CONFIG_PATH = "/api/config";
  var PROFILE_PATH = "/profile/info";
  var FRIENDS_TIMELINE_PATH = "/feed/friends";
  var TOPICS_PATH = "/api/container/getIndex?containerid=100803_-_followsuper";
  var TOPICS_FALLBACK_PATH = "/api/container/getIndex?containerid=100803_-_page_my_follow_super";
  var MAX_TOPIC_PAGES = 30;
  var MAX_FAILURE_DETAILS = 10;
  var MAX_TIMELINE_MEDIA = 12;
  var DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    "Referer": "https://m.weibo.cn/",
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "MWeibo-Pwa": "1"
  };
  defineFlareSocialPlugin({
    login: {
      browser: {
        async begin(_request, context) {
          return { type: "webCookie", startUrl: context.origin + "/" };
        },
        async check(request, context) {
          const probeUrl = context.origin + API_CONFIG_PATH;
          const cookieNames = ["SUB", "SUBP", "_T_WM", "MLOGIN", "ALF", "XSRF-TOKEN"];
          const cookieMap = /* @__PURE__ */ new Map();
          for (const cookie of request.cookies.cookies) {
            if (cookieNames.includes(cookie.name) && cookie.value) {
              cookieMap.set(cookie.name, cookie.value);
            }
          }
          if (!cookieMap.has("SUB") || !cookieMap.get("SUB")) {
            return { type: "pending" };
          }
          const cookies = Array.from(cookieMap.entries()).map(([name, value]) => ({ name, value }));
          const config = await requestJson(probeUrl, context, cookies, {}, true, true);
          if (!config || !isLoggedIn(config)) return { type: "pending" };
          const configData = isRecord(config.data) ? config.data : {};
          let user = null;
          if (isRecord(configData.user)) {
            user = configData.user;
          } else if (configData.uid) {
            user = {
              id: configData.uid,
              screen_name: configData.screen_name || String(configData.uid)
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
                true
              );
              if (profileResponse && isRecord(profileResponse.data) && isRecord(profileResponse.data.user)) {
                user = profileResponse.data.user;
              }
            } catch {
            }
          }
          if (!user) {
            return { type: "pending" };
          }
          const profile = mapProfile(user, context);
          const credential = { cookies, profile };
          return {
            type: "success",
            value: {
              accountId: profile.key.id,
              origin: context.origin,
              credential,
              profile,
              capabilities: { "flare.datasource.timeline/v1": ["page"] }
            }
          };
        }
      }
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
          const items = [];
          const isTopOrRefresh = request.page.direction === "refresh" || !request.page.cursor;
          if (isTopOrRefresh) {
            const results = [];
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
              const errorMsg = error && typeof error === "object" && "message" in error ? String(error.message?.value || error.message) : "";
              results.push({
                name: "\u8D85\u8BDD\u5217\u8868",
                status: "failed",
                message: errorMsg || "\u8BFB\u53D6\u7B7E\u5230\u72B6\u6001\u5931\u8D25\uFF1B\u672A\u63D0\u4EA4\u7B7E\u5230\uFF0C\u8BF7\u7A0D\u540E\u5237\u65B0\u91CD\u8BD5\u3002"
              });
            }
            items.push(await makeSummaryPost(results, truncated, credential.profile, context));
          }
          const feedPage = await fetchFriendsTimeline(
            context,
            credential.cookies,
            request.page.direction === "older" ? request.page.cursor : void 0
          );
          items.push(...feedPage.items);
          return {
            items,
            endReached: !feedPage.olderCursor,
            ...feedPage.olderCursor ? { olderCursor: feedPage.olderCursor } : {}
          };
        }
      }
    }
  });
  async function fetchFollowedTopics(context, cookies) {
    const config = await requestJson(context.origin + API_CONFIG_PATH, context, cookies);
    if (!config || !isLoggedIn(config)) {
      fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
    }
    const configData = isRecord(config.data) ? config.data : {};
    const xsrfToken = typeof configData.st === "string" ? configData.st : "";
    const results = [];
    const toCheck = [];
    const seen = /* @__PURE__ */ new Set();
    let sinceId = "";
    let truncated = false;
    for (let page = 0; page < MAX_TOPIC_PAGES; page++) {
      const url = context.origin + TOPICS_PATH + (sinceId ? "&since_id=" + encodeURIComponent(sinceId) : "");
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
  function hasCards(response) {
    const data = isRecord(response.data) ? response.data : {};
    return Array.isArray(data.cards) && data.cards.length > 0;
  }
  function parseTopicCards(response, seen, results, toCheck, context) {
    const data = isRecord(response.data) ? response.data : {};
    const cards = Array.isArray(data.cards) ? data.cards : [];
    let added = 0;
    for (const cardValue of cards) {
      if (!isRecord(cardValue)) continue;
      const entries = Array.isArray(cardValue.card_group) ? cardValue.card_group : [cardValue];
      for (const entryValue of entries) {
        if (!isRecord(entryValue)) continue;
        const name = typeof entryValue.title_sub === "string" && entryValue.title_sub.trim() || typeof entryValue.title === "string" && entryValue.title.trim() || typeof entryValue.card_title === "string" && entryValue.card_title.trim() || typeof entryValue.desc1 === "string" && entryValue.desc1.trim() || "";
        if (!name) continue;
        const button = Array.isArray(entryValue.buttons) && entryValue.buttons.length ? isRecord(entryValue.buttons[0]) ? entryValue.buttons[0] : {} : isRecord(entryValue.button) ? entryValue.button : {};
        const buttonName = typeof button.name === "string" ? button.name : "";
        const scheme = typeof button.scheme === "string" ? button.scheme : typeof entryValue.scheme === "string" ? entryValue.scheme : "";
        const id = topicId(scheme) || (typeof entryValue.itemid === "string" ? entryValue.itemid : name);
        if (seen.has(id)) continue;
        seen.add(id);
        added++;
        const isSigned = buttonName.includes("\u5DF2\u7B7E") || buttonName.includes("\u5DF2\u7C3D") || buttonName.includes("\u4ECA\u65E5\u5DF2\u7B7E") || buttonName.includes("\u4ECA\u65E5\u5DF2\u7C3D");
        const isCheckin = buttonName.includes("\u7B7E\u5230") || buttonName.includes("\u7C3D\u5230");
        if (isSigned) {
          results.push({ name, status: "already" });
        } else if (isCheckin && scheme) {
          const checkinUrl = resolveCheckinUrl(scheme, context);
          if (checkinUrl) {
            toCheck.push({ name, id, signed: false, checkinUrl });
          } else {
            results.push({ name, status: "unknown", message: "\u7B7E\u5230\u5730\u5740\u65E0\u6CD5\u8BC6\u522B" });
          }
        } else {
          results.push({ name, status: "unknown", message: "\u5FAE\u535A\u672A\u63D0\u4F9B\u53EF\u7528\u7B7E\u5230\u5165\u53E3" });
        }
      }
    }
    return added;
  }
  function resolveCheckinUrl(scheme, context) {
    if (!scheme || typeof scheme !== "string") return void 0;
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
    const match = /[?&](?:pageid|containerid)=([0-9a-zA-Z_-]+)/.exec(trimmed) || /containerid=([0-9a-zA-Z_-]+)/.exec(trimmed);
    if (match) {
      return `${context.origin}/api/container/getIndex?containerid=${encodeURIComponent(match[1])}_-_checkin`;
    }
    return void 0;
  }
  async function checkInTopic(topic, xsrfToken, context, cookies) {
    if (!topic.checkinUrl) {
      return { name: topic.name, status: "failed", message: "\u7F3A\u5C11\u6709\u6548\u7B7E\u5230\u5730\u5740\u3002" };
    }
    try {
      let url = topic.checkinUrl;
      if (xsrfToken && !/[?&]st=/.test(url)) {
        url += (url.includes("?") ? "&" : "?") + "st=" + encodeURIComponent(xsrfToken);
      }
      const headers = {};
      if (xsrfToken) {
        headers["x-xsrf-token"] = xsrfToken;
      }
      const response = await requestJson(url, context, cookies, headers, true, true);
      if (!response) {
        return { name: topic.name, status: "failed", message: "\u5FAE\u535A\u672A\u8FD4\u56DE\u7B7E\u5230\u7ED3\u679C\u3002" };
      }
      const message = extractMessage(response);
      const code = typeof response.code === "number" ? response.code : void 0;
      const ok = isOkResponse(response.ok) || code === 1e5 || response.result === 1 || response.result === "1";
      if (ok) {
        if (message.includes("\u5DF2\u7B7E") || message.includes("\u5DF2\u7C3D")) {
          return { name: topic.name, status: "already", message };
        }
        return { name: topic.name, status: "success", message: message || "\u7B7E\u5230\u6210\u529F" };
      }
      if (message.includes("\u5DF2\u7B7E") || message.includes("\u5DF2\u7C3D") || code === 382004) {
        return { name: topic.name, status: "already", message: message || "\u4ECA\u65E5\u5DF2\u7B7E\u5230" };
      }
      return {
        name: topic.name,
        status: "failed",
        message: safeRemoteMessage(message || (typeof response.msg === "string" ? response.msg : ""))
      };
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      return { name: topic.name, status: "failed", message: "\u7B7E\u5230\u8BF7\u6C42\u5931\u8D25\u6216\u88AB\u98CE\u63A7\u3002" };
    }
  }
  async function fetchFriendsTimeline(context, cookies, cursor) {
    const url = context.origin + FRIENDS_TIMELINE_PATH + (cursor ? "?max_id=" + encodeURIComponent(cursor) : "");
    let response = null;
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
    const items = data.statuses.map((status) => mapTimelineStatus(status, context)).filter((item) => item !== void 0);
    const rawCursor = data.next_cursor_str ?? data.next_cursor;
    const olderCursor = optionalScalarText(rawCursor);
    return {
      items,
      ...olderCursor && olderCursor !== cursor ? { olderCursor } : {}
    };
  }
  function mapTimelineStatus(value, context) {
    if (!isRecord(value)) return void 0;
    const post = mapTimelinePost(value, context);
    if (!post) return void 0;
    const retweetedStatus = isRecord(value.retweeted_status) ? mapTimelinePost(value.retweeted_status, context) : void 0;
    return {
      type: "post",
      post,
      ...retweetedStatus ? { presentation: { repost: retweetedStatus } } : {}
    };
  }
  function mapTimelinePost(value, context) {
    const id = optionalScalarText(value.idstr ?? value.id ?? value.mid);
    if (!id) return void 0;
    const host = accountHost(context);
    const statusText = optionalScalarText(value.raw_text) || htmlToPlainText(optionalScalarText(value.text) || "");
    const user = isRecord(value.user) ? mapTimelineProfile(value.user, context) : void 0;
    const post = {
      key: { id, host },
      createdAt: parseWeiboDate(optionalScalarText(value.created_at)),
      content: { format: "plain", value: statusText || "\uFF08\u5FAE\u535A\u5185\u5BB9\u4E3A\u7A7A\uFF09" },
      detailType: "link",
      url: context.origin + "/detail/" + encodeURIComponent(id),
      ...user ? { author: user } : {}
    };
    const media = mapStatusImages(value, id);
    if (media.length) post.media = media;
    const repliesCount = optionalNonnegativeNumber(value.comments_count);
    const repostsCount = optionalNonnegativeNumber(value.reposts_count);
    const favouritesCount = optionalNonnegativeNumber(value.attitudes_count);
    if (repliesCount !== void 0) post.repliesCount = repliesCount;
    if (repostsCount !== void 0) post.repostsCount = repostsCount;
    if (favouritesCount !== void 0) post.favouritesCount = favouritesCount;
    return post;
  }
  function mapTimelineProfile(user, context) {
    const id = optionalScalarText(user.idstr ?? user.id);
    const handle = optionalScalarText(user.screen_name);
    if (!id || !handle) return void 0;
    const avatarUrl = safeWeiboMediaUrl(user.avatar_hd ?? user.profile_image_url);
    return {
      key: { id, host: accountHost(context) },
      handle,
      displayName: handle,
      ...avatarUrl ? { avatarUrl } : {}
    };
  }
  function mapStatusImages(status, statusId) {
    const rawPics = status.pics;
    const pics = Array.isArray(rawPics) ? rawPics : isRecord(rawPics) ? Object.values(rawPics) : [];
    const media = [];
    for (const [index, rawPic] of pics.entries()) {
      if (!isRecord(rawPic)) continue;
      const large = isRecord(rawPic.large) ? rawPic.large : {};
      const rawUrl = optionalScalarText(large.url) || optionalScalarText(rawPic.url);
      const url = safeWeiboMediaUrl(rawUrl);
      if (!url) continue;
      const previewUrl = safeWeiboMediaUrl(optionalScalarText(rawPic.url)) || url;
      const geo = isRecord(large.geo) ? large.geo : isRecord(rawPic.geo) ? rawPic.geo : {};
      const width = optionalPositiveNumber(geo.width);
      const height = optionalPositiveNumber(geo.height);
      const picId = optionalScalarText(rawPic.pid) || `${statusId}-image-${index}`;
      media.push({
        id: picId,
        type: "image",
        url,
        previewUrl,
        ...width !== void 0 ? { width } : {},
        ...height !== void 0 ? { height } : {}
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
          previewUrl: safeWeiboMediaUrl(status.thumbnail_pic) || fallbackUrl
        });
      }
    }
    return media;
  }
  function safeWeiboMediaUrl(value) {
    if (typeof value !== "string" || !value.trim()) return void 0;
    const candidate = value.trim().startsWith("http://") ? "https://" + value.trim().slice("http://".length) : value.trim();
    const match = /^https:\/\/([^/]+)\//i.exec(candidate);
    if (!match) return void 0;
    const host = match[1].toLowerCase();
    const allowed = host === "sinaimg.cn" || host.endsWith(".sinaimg.cn") || host.endsWith(".weibocdn.com");
    return allowed ? candidate : void 0;
  }
  function parseWeiboDate(value) {
    const pattern = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})\s+(\d{4})$/;
    const match = pattern.exec(value || "");
    if (match) {
      const months = {
        Jan: 0,
        Feb: 1,
        Mar: 2,
        Apr: 3,
        May: 4,
        Jun: 5,
        Jul: 6,
        Aug: 7,
        Sep: 8,
        Oct: 9,
        Nov: 10,
        Dec: 11
      };
      const month = months[match[1]];
      if (month !== void 0) {
        const localTime = Date.UTC(
          Number(match[9]),
          month,
          Number(match[2]),
          Number(match[3]),
          Number(match[4]),
          Number(match[5])
        );
        const offsetMinutes = (Number(match[7]) * 60 + Number(match[8])) * (match[6] === "+" ? 1 : -1);
        return new Date(localTime - offsetMinutes * 6e4).toISOString();
      }
    }
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
  }
  function htmlToPlainText(value) {
    return decodeHtmlEntities(
      value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li)>/gi, "\n").replace(/<[^>]*>/g, "").replace(/[ \t]+\n/g, "\n").trim()
    );
  }
  function decodeHtmlEntities(value) {
    const named = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " "
    };
    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        const point = Number.parseInt(code.slice(2), 16);
        return Number.isInteger(point) && point >= 0 && point <= 1114111 ? String.fromCodePoint(point) : entity;
      }
      if (code.startsWith("#")) {
        const point = Number.parseInt(code.slice(1), 10);
        return Number.isInteger(point) && point >= 0 && point <= 1114111 ? String.fromCodePoint(point) : entity;
      }
      return named[code.toLowerCase()] ?? entity;
    });
  }
  async function makeSummaryPost(results, truncated, profile, context) {
    const already = results.filter((item) => item.status === "already").length;
    const success = results.filter((item) => item.status === "success").length;
    const failed = results.filter((item) => item.status === "failed").length;
    const unknown = results.filter((item) => item.status === "unknown").length;
    const checked = already + success + failed + unknown;
    const now = /* @__PURE__ */ new Date();
    const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
    const lines = [
      `\u3010\u8D85\u8BDD\u7B7E\u5230\u901A\u77E5 \xB7 ${timeStr}\u3011`,
      `\u5173\u6CE8\u8D85\u8BDD\uFF1A\u5171 ${checked} \u4E2A\uFF08\u5DF2\u7B7E ${already}\uFF0C\u672C\u6B21\u6210\u529F ${success}\uFF0C\u5931\u8D25 ${failed}\uFF09`
    ];
    if (unknown > 0) lines.push(`\u2139\uFE0F \u53E6\u6709 ${unknown} \u4E2A\u8D85\u8BDD\u672A\u8BC6\u522B\u5230\u7B7E\u5230\u5165\u53E3\u3002`);
    if (truncated) lines.push(`\u26A0\uFE0F \u8D85\u8BDD\u5217\u8868\u5DF2\u8FBE ${MAX_TOPIC_PAGES} \u9875\u9650\u5236\u3002`);
    const successes = results.filter((item) => item.status === "success").slice(0, 5);
    if (successes.length) {
      lines.push("\u2705 \u672C\u6B21\u7B7E\u5230\u6210\u529F\uFF1A" + successes.map((item) => item.name).join("\u3001"));
    }
    const failures = results.filter((item) => item.status === "failed").slice(0, MAX_FAILURE_DETAILS);
    if (failures.length) {
      lines.push("\u274C \u7B7E\u5230\u5931\u8D25\uFF1A" + failures.map((item) => `${item.name}\uFF08${item.message || "\u8BF7\u6C42\u5931\u8D25"}\uFF09`).join("\uFF1B"));
    }
    if (checked === 0) {
      lines.push("\uFF08\u672A\u626B\u63CF\u5230\u5173\u6CE8\u7684\u8D85\u8BDD\uFF0C\u8BF7\u786E\u8BA4\u5FAE\u535A\u8D26\u53F7\u5DF2\u5173\u6CE8\u8D85\u8BDD\uFF09");
    }
    return {
      type: "post",
      post: {
        key: { id: "checkin-summary-" + await flare.crypto.uuid(), host: accountHost(context) },
        createdAt: now.toISOString(),
        author: profile,
        content: { format: "plain", value: lines.join("\n") },
        detailType: "link",
        url: context.origin + "/"
      }
    };
  }
  async function requestJson(url, context, cookies, extraHeaders = {}, allowUnauthorized = false, allowNotFound = false) {
    if (!isSameOrigin(url, context.origin)) {
      fail("Unsupported", "\u5FAE\u535A\u63A5\u53E3\u8DF3\u8F6C\u5230\u4E86\u6240\u9009\u8D26\u53F7\u7AD9\u70B9\u4E4B\u5916\uFF0C\u5DF2\u505C\u6B62\u8BF7\u6C42\u3002");
    }
    let response;
    try {
      response = await flare.http.request({
        method: "GET",
        url,
        cookies,
        headers: {
          ...DEFAULT_HEADERS,
          "Referer": context.origin + "/",
          ...extraHeaders
        }
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "host.unavailable") {
        fail("Network", "Flare \u65E0\u6CD5\u8FDE\u63A5\u5FAE\u535A\u63A5\u53E3\u3002");
      }
      throw error;
    }
    if (response.status === 401 && allowUnauthorized) return null;
    if (response.status === 404 && allowNotFound) return null;
    if (response.status === 401 || response.status === 403) {
      fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\u6216\u8BF7\u6C42\u672A\u83B7\u6388\u6743\u3002");
    }
    if (response.status < 200 || response.status >= 300) {
      fail("Remote", "\u5FAE\u535A\u63A5\u53E3\u8FD4\u56DE HTTP " + response.status + "\u3002");
    }
    let value;
    try {
      value = JSON.parse(response.body);
    } catch {
      fail("InvalidResponse", "\u5FAE\u535A\u63A5\u53E3\u6CA1\u6709\u8FD4\u56DE\u6709\u6548 JSON\u3002");
    }
    return requiredObject(value);
  }
  async function readCredential() {
    const value = await flare.credential.read();
    if (!isRecord(value)) {
      fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u4FE1\u606F\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
    }
    const record = value;
    if (!Array.isArray(record.cookies) || !isRecord(record.profile)) {
      fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u4FE1\u606F\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
    }
    const cookies = record.cookies.filter(isCookiePair);
    if (!cookies.some((cookie) => cookie.name === "SUB" && cookie.value)) {
      fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55 Cookie \u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
    }
    return { cookies, profile: record.profile };
  }
  function mapProfile(user, context) {
    const id = requiredScalarText(user.idstr ?? user.id);
    const handle = requiredScalarText(user.screen_name);
    const avatarUrl = safeWeiboMediaUrl(user.avatar_hd ?? user.profile_image_url);
    return {
      key: { id, host: accountHost(context) },
      handle,
      displayName: handle,
      ...avatarUrl ? { avatarUrl } : {}
    };
  }
  function isLoggedIn(value) {
    const data = isRecord(value.data) ? value.data : {};
    return data.login === true || data.login === 1 || data.login === "1";
  }
  function isOkResponse(value) {
    return value === 1 || value === true || value === "1";
  }
  function topicId(scheme) {
    const match = /containerid=([0-9a-zA-Z_-]+)/.exec(scheme);
    return match ? match[1] : "";
  }
  function isSameOrigin(url, origin) {
    return url === origin || url.startsWith(origin + "/");
  }
  function extractMessage(value) {
    const data = isRecord(value.data) ? value.data : {};
    if (typeof data.msg === "string") return data.msg;
    const button = isRecord(data.button) ? data.button : {};
    if (typeof button.name === "string") return button.name;
    return typeof value.msg === "string" ? value.msg : "";
  }
  function safeRemoteMessage(value) {
    const message = value.trim().replace(/[\r\n\t]+/g, " ").slice(0, 100);
    return message || "\u5FAE\u535A\u672A\u786E\u8BA4\u7B7E\u5230\u7ED3\u679C\u3002";
  }
  function isAuthenticationError(error) {
    return isRecord(error) && error.code === "AuthenticationRequired";
  }
  function isCookiePair(value) {
    return isRecord(value) && typeof value.name === "string" && typeof value.value === "string";
  }
  function accountHost(context) {
    return context.origin.slice("https://".length);
  }
  function requiredScalarText(value) {
    if (typeof value !== "string" && typeof value !== "number" || !String(value).trim()) {
      fail("InvalidResponse", "\u5FAE\u535A\u6CA1\u6709\u8FD4\u56DE\u6709\u6548\u8D26\u53F7\u8D44\u6599\u3002");
    }
    return String(value);
  }
  function optionalScalarText(value) {
    if (typeof value === "string") return value.trim() || void 0;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return void 0;
  }
  function optionalNonnegativeNumber(value) {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(number) && number >= 0 ? number : void 0;
  }
  function optionalPositiveNumber(value) {
    const number = optionalNonnegativeNumber(value);
    return number !== void 0 && number > 0 ? number : void 0;
  }
  function requiredObject(value) {
    if (!isRecord(value)) fail("InvalidResponse", "\u5FAE\u535A\u63A5\u53E3\u8FD4\u56DE\u4E86\u975E\u5BF9\u8C61\u6570\u636E\u3002");
    return value;
  }
  function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }
  function fail(code, message) {
    throw flare.error({ code, message: { value: message } });
  }
})();
