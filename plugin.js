"use strict";
(() => {
  // src/plugin.ts
  var API_CONFIG_PATH = "/api/config";
  var API_CONFIG_LIST_PATH = "/api/config/list";
  var TIMELINE_FRIENDS_PATH = "/feed/friends";
  var TIMELINE_CIRCLE_PATH = "/feed/circle";
  var TIMELINE_PRIVATE_PATH = "/feed/private";
  var TIMELINE_GROUP_PATH = "/feed/group";
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
    detector: {
      async detect(request, context) {
        const origin = request.origin || context.origin || "https://m.weibo.cn";
        const hostMatch = origin.match(/^https?:\/\/([^/:]+)/i);
        const host = hostMatch ? hostMatch[1].toLowerCase() : "";
        const isWeibo = host === "m.weibo.cn" || host.endsWith(".weibo.cn") || host === "weibo.cn" || host === "weibo.com" || host.endsWith(".weibo.com");
        if (!isWeibo) {
          return { match: "none", canonicalOrigin: origin };
        }
        try {
          const response = await flare.http.request({
            method: "GET",
            url: origin + API_CONFIG_PATH,
            headers: DEFAULT_HEADERS
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
                  description: "\u5FAE\u535A\u589E\u5F3A\u7248 (\u652F\u6301\u8D85\u8BDD\u81EA\u52A8\u7B7E\u5230)"
                }
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
                description: "\u5FAE\u535A\u589E\u5F3A\u7248 (\u652F\u6301\u8D85\u8BDD\u81EA\u52A8\u7B7E\u5230)"
              }
            };
          }
        }
        return {
          match: "none",
          canonicalOrigin: origin
        };
      }
    },
    login: {
      browser: {
        async begin(_request, _context) {
          return {
            type: "webCookie",
            startUrl: "https://m.weibo.cn/login?backURL=https%3A%2F%2Fm.weibo.cn%2F"
          };
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
          const uid = configData.uid ? String(configData.uid) : "";
          let user = null;
          if (isRecord(configData.user)) {
            user = configData.user;
          }
          if (uid && (!user || !user.avatar_hd || !user.screen_name)) {
            try {
              const userIndex = await requestJson(
                context.origin + "/api/container/getIndex?type=uid&value=" + encodeURIComponent(uid),
                context,
                cookies,
                {},
                true,
                true
              );
              if (userIndex && isRecord(userIndex.data) && isRecord(userIndex.data.userInfo)) {
                user = {
                  ...user || {},
                  ...userIndex.data.userInfo
                };
              }
            } catch {
            }
          }
          if (uid && (!user || !user.avatar_hd || !user.screen_name)) {
            try {
              const userIndex = await requestJson(
                context.origin + "/api/container/getIndex?type=uid&value=" + encodeURIComponent(uid) + "&containerid=100505" + encodeURIComponent(uid),
                context,
                cookies,
                {},
                true,
                true
              );
              if (userIndex && isRecord(userIndex.data) && isRecord(userIndex.data.userInfo)) {
                user = {
                  ...user || {},
                  ...userIndex.data.userInfo
                };
              }
            } catch {
            }
          }
          if (!user && uid) {
            user = {
              id: uid,
              screen_name: configData.screen_name ? String(configData.screen_name) : uid
            };
          }
          if (!user || !user.id && !user.idstr) {
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
              capabilities: {
                "flare.datasource.timeline/v1": ["page"],
                "flare.datasource.tab-catalog/v1": ["page"],
                "flare.datasource.post/v1": ["detail", "context", "mutate", "delete"],
                "flare.datasource.notification/v1": ["page", "badge"],
                "flare.datasource.compose/v1": ["publish"],
                "flare.datasource.profile/v1": ["byId", "byHandle"]
              }
            }
          };
        }
      }
    },
    capabilities: {
      timeline: {
        async page(request, context) {
          const credential = await readCredential();
          if (!credential.profile.avatarUrl && credential.profile.key.id) {
            try {
              const userIndex = await requestJson(
                context.origin + "/api/container/getIndex?type=uid&value=" + encodeURIComponent(credential.profile.key.id),
                context,
                credential.cookies,
                {},
                true,
                true
              );
              if (userIndex && isRecord(userIndex.data) && isRecord(userIndex.data.userInfo)) {
                const uInfo = userIndex.data.userInfo;
                const avatarUrl = safeWeiboMediaUrl(uInfo.avatar_hd ?? uInfo.profile_image_url);
                const screenName = requiredScalarText(uInfo.screen_name ?? credential.profile.displayName);
                if (avatarUrl || screenName) {
                  credential.profile = {
                    ...credential.profile,
                    ...screenName ? { displayName: screenName, handle: screenName } : {},
                    ...avatarUrl ? { avatarUrl } : {}
                  };
                  await flare.credential.replace(credential);
                }
              }
            } catch {
            }
          }
          const timelineId = request.timelineId || "checkin";
          if (request.page.direction !== "refresh" && request.page.direction !== "older") {
            return { items: [], endReached: true };
          }
          const items = [];
          const isTopOrRefresh = request.page.direction === "refresh" || !request.page.cursor;
          if (timelineId === "checkin" && isTopOrRefresh) {
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
          let feedEndpoint = TIMELINE_FRIENDS_PATH;
          if (timelineId === "friends") {
            feedEndpoint = TIMELINE_CIRCLE_PATH;
          } else if (timelineId === "private") {
            feedEndpoint = TIMELINE_PRIVATE_PATH;
          } else if (timelineId === "special") {
            const groups = await fetchUserGroups(context, credential.cookies);
            const specialGroup = groups.find((g) => g.name === "\u7279\u522B\u5173\u6CE8" || g.name.includes("\u7279\u522B\u5173\u6CE8"));
            if (specialGroup) {
              feedEndpoint = `${TIMELINE_GROUP_PATH}?gid=${encodeURIComponent(specialGroup.gid)}`;
            } else if (groups.length > 0) {
              feedEndpoint = `${TIMELINE_GROUP_PATH}?gid=${encodeURIComponent(groups[0].gid)}`;
            } else {
              feedEndpoint = TIMELINE_CIRCLE_PATH;
            }
          } else if (timelineId.startsWith("group-")) {
            feedEndpoint = `${TIMELINE_GROUP_PATH}?gid=${encodeURIComponent(timelineId.slice("group-".length))}`;
          } else if (timelineId.startsWith("group:")) {
            feedEndpoint = `${TIMELINE_GROUP_PATH}?gid=${encodeURIComponent(timelineId.slice("group:".length))}`;
          } else if (request.parameters && typeof request.parameters.gid === "string") {
            feedEndpoint = `${TIMELINE_GROUP_PATH}?gid=${encodeURIComponent(request.parameters.gid)}`;
          }
          const cursor = request.page.direction === "older" ? request.page.cursor : void 0;
          const feedPage = await fetchTimelineFeed(
            feedEndpoint,
            context,
            credential.cookies,
            cursor
          );
          items.push(...feedPage.items);
          return {
            items,
            endReached: !feedPage.olderCursor,
            ...feedPage.olderCursor ? { olderCursor: feedPage.olderCursor } : {}
          };
        }
      },
      tabCatalog: {
        async page(_request, context) {
          let dynamicGroups = [];
          try {
            const credential = await readCredential();
            dynamicGroups = await fetchUserGroups(context, credential.cookies);
          } catch {
          }
          const timelineItems = [
            { id: "checkin", title: { value: "\u6700\u65B0\u5FAE\u535AEnhance" }, icon: "Home" },
            { id: "friends", title: { value: "\u597D\u53CB\u5708" }, icon: "Follow" },
            { id: "private", title: { value: "\u6084\u6084\u5173\u6CE8" }, icon: "Bookmark" }
          ];
          let hasSpecial = false;
          for (const g of dynamicGroups) {
            if (g.name === "\u7279\u522B\u5173\u6CE8" || g.name.includes("\u7279\u522B\u5173\u6CE8")) {
              hasSpecial = true;
              timelineItems.push({
                id: "special",
                title: { value: g.name },
                icon: "Featured"
              });
            } else {
              const safeGid = g.gid.replace(/[^0-9a-zA-Z_.-]/g, "_");
              timelineItems.push({
                id: "group-" + safeGid,
                title: { value: g.name },
                icon: "List",
                parameters: { gid: g.gid }
              });
            }
          }
          if (!hasSpecial) {
            timelineItems.push({
              id: "special",
              title: { value: "\u7279\u522B\u5173\u6CE8" },
              icon: "Featured"
            });
          }
          return {
            items: [
              {
                id: "weibo_groups",
                title: { value: "\u5FAE\u535A\u5206\u7EC4" },
                timelines: {
                  items: timelineItems,
                  endReached: true
                }
              }
            ],
            endReached: true
          };
        }
      },
      post: {
        async detail(request, context) {
          const credential = await readCredential();
          const id = request.key.id;
          const st = await getCsrfToken(context, credential.cookies).catch(() => void 0);
          const data = await fetchSingleStatus(id, context, credential.cookies, st);
          if (!data) {
            fail("NotFound", "\u5FAE\u535A\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664\u3002");
          }
          const post = mapTimelinePost(data, context, credential.profile.key.id);
          if (!post) {
            fail("NotFound", "\u65E0\u6CD5\u89E3\u6790\u8BE5\u5FAE\u535A\u3002");
          }
          const retweet = isRecord(data.retweeted_status) ? mapTimelinePost(data.retweeted_status, context, credential.profile.key.id) : void 0;
          return {
            post,
            ...retweet ? {
              presentation: {
                quotes: [retweet]
              }
            } : {}
          };
        },
        async context(request, context) {
          const credential = await readCredential();
          const id = request.key.id;
          const cursor = request.page.cursor;
          const currentUserId = credential.profile.key.id;
          const items = [];
          const mid = /^\d+$/.test(id) ? id : bidToMid(id) || id;
          let rootComments = [];
          let nextCursor = void 0;
          try {
            let url = context.origin + "/comments/hotflow?id=" + encodeURIComponent(mid) + "&mid=" + encodeURIComponent(mid) + "&max_id_type=0";
            if (cursor && !cursor.startsWith("page_")) {
              url += "&max_id=" + encodeURIComponent(cursor);
            }
            const response = await requestJson(
              url,
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(id) },
              true,
              true
            );
            if (response && isOkResponse(response.ok) && isRecord(response.data)) {
              const data = response.data;
              if (Array.isArray(data.data)) {
                rootComments = data.data;
              } else if (Array.isArray(data.root_comments)) {
                rootComments = data.root_comments;
              }
              const rawMaxId = data.max_id;
              if ((typeof rawMaxId === "number" || typeof rawMaxId === "string") && String(rawMaxId) !== "0" && String(rawMaxId) !== cursor) {
                nextCursor = String(rawMaxId);
              }
            }
          } catch {
          }
          if (!rootComments.length && !cursor) {
            try {
              const showUrl = context.origin + "/api/comments/show?id=" + encodeURIComponent(mid) + "&page=1";
              const response = await requestJson(
                showUrl,
                context,
                credential.cookies,
                { Referer: context.origin + "/detail/" + encodeURIComponent(id) },
                true,
                true
              );
              if (response && isOkResponse(response.ok) && isRecord(response.data)) {
                const data = response.data;
                if (Array.isArray(data.data)) {
                  rootComments = data.data;
                }
                const rawMax = data.max;
                if (typeof rawMax === "number" && rawMax > 1) {
                  nextCursor = "page_2";
                }
              }
            } catch {
            }
          } else if (!rootComments.length && cursor && cursor.startsWith("page_")) {
            const pageNum = parseInt(cursor.replace("page_", ""), 10) || 1;
            try {
              const showUrl = context.origin + "/api/comments/show?id=" + encodeURIComponent(mid) + "&page=" + pageNum;
              const response = await requestJson(
                showUrl,
                context,
                credential.cookies,
                { Referer: context.origin + "/detail/" + encodeURIComponent(id) },
                true,
                true
              );
              if (response && isOkResponse(response.ok) && isRecord(response.data)) {
                const data = response.data;
                if (Array.isArray(data.data)) {
                  rootComments = data.data;
                }
                const rawMax = data.max;
                if (typeof rawMax === "number" && pageNum < rawMax) {
                  nextCursor = "page_" + (pageNum + 1);
                }
              }
            } catch {
            }
          }
          for (const c of rootComments) {
            if (!isRecord(c)) continue;
            const commentPost = mapCommentPost(c, id, currentUserId, context);
            if (commentPost) {
              items.push({
                type: "post",
                post: commentPost
              });
            }
          }
          return {
            items,
            endReached: !nextCursor,
            ...nextCursor ? { olderCursor: nextCursor } : {}
          };
        },
        async mutate(request, context) {
          const credential = await readCredential();
          const st = await getCsrfToken(context, credential.cookies);
          if (!st) {
            fail("AuthenticationRequired", "\u65E0\u6CD5\u83B7\u53D6\u5FAE\u535A\u5B89\u5168\u51ED\u8BC1 (st)\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
          }
          const rawId = request.actionToken || request.key.id;
          const isComment = rawId.startsWith("comment_") || rawId.startsWith("comment-");
          let statusId = rawId;
          let commentId = "";
          if (isComment) {
            const parts = rawId.split(/[-_]/);
            if (parts.length >= 3) {
              statusId = parts[1];
              commentId = parts[2];
            } else {
              commentId = rawId.replace(/^comment[-_]/, "");
              statusId = commentId;
            }
          }
          const numericStatusId = /^\d+$/.test(statusId) ? statusId : bidToMid(statusId) || statusId;
          if (isComment) {
            if (request.action === "Favourite") {
              await performLikeAction(
                context.origin + "/api/likes/update",
                { id: commentId, type: "comment" },
                context,
                credential.cookies,
                false
              );
              return { type: "noChange" };
            } else if (request.action === "Unfavourite") {
              await performLikeAction(
                context.origin + "/api/likes/destroy",
                { id: commentId, type: "comment" },
                context,
                credential.cookies,
                true
              );
              return { type: "noChange" };
            } else if (request.action === "Delete") {
              await requestFormPost(
                context.origin + "/comments/destroy",
                { cid: commentId, st },
                context,
                credential.cookies
              );
              return { type: "deleted" };
            }
            return { type: "noChange" };
          } else {
            if (request.action === "Favourite") {
              await performLikeAction(
                context.origin + "/api/attitudes/create",
                { id: numericStatusId, attitude: "heart" },
                context,
                credential.cookies,
                false
              );
              return { type: "noChange" };
            } else if (request.action === "Unfavourite") {
              await performLikeAction(
                context.origin + "/api/attitudes/destroy",
                { id: numericStatusId, attitude: "heart" },
                context,
                credential.cookies,
                true
              );
              return { type: "noChange" };
            } else if (request.action === "Repost") {
              const content = request.parameters?.content || "\u8F6C\u53D1\u5FAE\u535A";
              const res = await requestFormPost(
                context.origin + "/api/statuses/repost",
                { id: numericStatusId, mid: numericStatusId, content, st },
                context,
                credential.cookies
              );
              if (!res || !isOkResponse(res.ok)) {
                const msg = isRecord(res) && typeof res.msg === "string" ? res.msg : "\u8F6C\u53D1\u5931\u8D25\u3002";
                fail("Remote", msg);
              }
              return { type: "noChange" };
            } else if (request.action === "Bookmark") {
              await requestFormPost(
                context.origin + "/api/statuses/createfav",
                { id: numericStatusId, st },
                context,
                credential.cookies
              );
              return { type: "noChange" };
            } else if (request.action === "Unbookmark") {
              await requestFormPost(
                context.origin + "/api/statuses/destroyfav",
                { id: numericStatusId, st },
                context,
                credential.cookies
              );
              return { type: "noChange" };
            } else if (request.action === "Delete") {
              await requestFormPost(
                context.origin + "/profile/delMyblog",
                { mid: numericStatusId, st },
                context,
                credential.cookies,
                { Referer: context.origin + "/" }
              );
              return { type: "deleted" };
            }
            return { type: "noChange" };
          }
        },
        async delete(request, context) {
          const credential = await readCredential();
          const st = await getCsrfToken(context, credential.cookies);
          const rawId = request.key.id;
          if (rawId.startsWith("comment_") || rawId.startsWith("comment-")) {
            const parts = rawId.split("_");
            const commentId = parts.length >= 3 ? parts[2] : rawId.replace(/^comment[-_]/, "");
            const statusId = parts.length >= 3 ? parts[1] : commentId;
            await requestFormPost(
              context.origin + "/comments/destroy",
              { cid: commentId, st },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) }
            );
          } else {
            await requestFormPost(
              context.origin + "/profile/delMyblog",
              { mid: rawId, st },
              context,
              credential.cookies,
              { Referer: context.origin + "/" }
            );
          }
          return { type: "deleted" };
        }
      },
      compose: {
        async publish(request, context) {
          const credential = await readCredential();
          const st = await getCsrfToken(context, credential.cookies);
          if (request.replyTo) {
            const rawId = request.replyTo.id;
            if (rawId.startsWith("comment_") || rawId.startsWith("comment-")) {
              const parts = rawId.split("_");
              let statusId = "";
              let commentId = "";
              if (parts.length >= 3) {
                statusId = parts[1];
                commentId = parts[2];
              } else {
                commentId = rawId.replace(/^comment[-_]/, "");
                statusId = commentId;
              }
              const res = await requestFormPost(
                context.origin + "/api/comments/reply",
                {
                  id: statusId,
                  mid: statusId,
                  cid: commentId,
                  reply: commentId,
                  content: request.text,
                  st
                },
                context,
                credential.cookies,
                { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) }
              );
              if (!res || !isOkResponse(res.ok) || !isRecord(res.data)) {
                const msg = isRecord(res) && typeof res.msg === "string" ? res.msg : "\u56DE\u590D\u53D1\u5E03\u5931\u8D25\u3002";
                fail("Remote", msg);
              }
              const commentData = res.data;
              const mapped = mapCommentPost(commentData, statusId, credential.profile.key.id, context);
              if (mapped) {
                return { post: mapped };
              }
              const post = {
                key: { id: "comment_" + statusId + "_" + (commentData.idstr || commentData.id || String(Date.now())), host: accountHost(context) },
                createdAt: parseWeiboDate(typeof commentData.created_at === "string" ? commentData.created_at : void 0),
                content: { format: "plain", value: request.text },
                author: credential.profile,
                replyTo: request.replyTo
              };
              return { post };
            } else {
              const statusId = rawId;
              const res = await requestFormPost(
                context.origin + "/api/comments/create",
                {
                  id: statusId,
                  mid: statusId,
                  content: request.text,
                  st
                },
                context,
                credential.cookies,
                { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) }
              );
              if (!res || !isOkResponse(res.ok) || !isRecord(res.data)) {
                const msg = isRecord(res) && typeof res.msg === "string" ? res.msg : "\u8BC4\u8BBA\u53D1\u5E03\u5931\u8D25\u3002";
                fail("Remote", msg);
              }
              const commentData = res.data;
              const mapped = mapCommentPost(commentData, statusId, credential.profile.key.id, context);
              if (mapped) {
                return { post: mapped };
              }
              const post = {
                key: { id: "comment_" + statusId + "_" + (commentData.idstr || commentData.id || String(Date.now())), host: accountHost(context) },
                createdAt: parseWeiboDate(typeof commentData.created_at === "string" ? commentData.created_at : void 0),
                content: { format: "plain", value: request.text },
                author: credential.profile,
                replyTo: request.replyTo
              };
              return { post };
            }
          } else {
            const formValues = {
              content: request.text,
              st
            };
            if (request.visibility === "followers") {
              formValues.visible = "6";
            }
            const res = await requestFormPost(
              context.origin + "/api/statuses/update",
              formValues,
              context,
              credential.cookies,
              { Referer: context.origin + "/" }
            );
            if (!res || !isOkResponse(res.ok) || !isRecord(res.data)) {
              const msg = isRecord(res) && typeof res.msg === "string" ? res.msg : "\u5FAE\u535A\u53D1\u5E03\u5931\u8D25\u3002";
              fail("Remote", msg);
            }
            const statusData = res.data;
            const post = mapTimelinePost(statusData, context, credential.profile.key.id);
            if (!post) {
              fail("Remote", "\u65E0\u6CD5\u89E3\u6790\u65B0\u53D1\u5E03\u7684\u5FAE\u535A\u3002");
            }
            return { post };
          }
        }
      },
      profile: {
        async byId(request, context) {
          const credential = await readCredential();
          return await fetchProfileData(request.key.id, context, credential.cookies);
        },
        async byHandle(request, context) {
          const credential = await readCredential();
          return await fetchProfileData(request.handle, context, credential.cookies);
        }
      },
      notification: {
        async page(request, context) {
          const credential = await readCredential();
          if (!credential.cookies || !credential.cookies.some((c) => c.name === "SUB" && c.value)) {
            fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
          }
          const currentUserId = credential.profile.key.id;
          const host = accountHost(context);
          const filterId = request.filterId || "mention";
          const cursor = request.page.cursor;
          const pageNum = cursor ? parseInt(cursor, 10) || 1 : 1;
          const items = [];
          let hasMore = false;
          const defaultHeaders = { Referer: context.origin + "/" };
          if (filterId === "mention") {
            try {
              const url = context.origin + "/message/mentionsAt?page=" + pageNum;
              const res = await requestJson(
                url,
                context,
                credential.cookies,
                defaultHeaders,
                true,
                true
              );
              if (res && isOkResponse(res.ok)) {
                const list = Array.isArray(res.data) ? res.data : isRecord(res.data) && Array.isArray(res.data.statuses) ? res.data.statuses : isRecord(res.data) && Array.isArray(res.data.data) ? res.data.data : [];
                if (list.length > 0) {
                  hasMore = true;
                  for (const item of list) {
                    if (!isRecord(item)) continue;
                    const post = mapTimelinePost(item, context, currentUserId);
                    if (!post) continue;
                    const retweet = isRecord(item.retweeted_status) ? mapTimelinePost(item.retweeted_status, context, currentUserId) : void 0;
                    items.push({
                      type: "post",
                      post,
                      ...retweet ? { presentation: { quotes: [retweet] } } : {}
                    });
                  }
                }
              } else if (res && res.ok === -100) {
                fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
              }
            } catch (e) {
              if (isAuthenticationError(e)) throw e;
            }
          } else if (filterId === "comment") {
            try {
              const url = context.origin + "/message/cmt?page=" + pageNum;
              const res = await requestJson(
                url,
                context,
                credential.cookies,
                defaultHeaders,
                true,
                true
              );
              if (res && isOkResponse(res.ok)) {
                const list = Array.isArray(res.data) ? res.data : isRecord(res.data) && Array.isArray(res.data.comments) ? res.data.comments : isRecord(res.data) && Array.isArray(res.data.data) ? res.data.data : [];
                if (list.length > 0) {
                  hasMore = true;
                  for (const c of list) {
                    if (!isRecord(c)) continue;
                    const commentId = String(c.idstr || c.id || "");
                    if (!commentId) continue;
                    const commentUser = isRecord(c.user) ? mapTimelineProfile(c.user, context) : void 0;
                    const commentUserId = commentUser ? commentUser.key.id : void 0;
                    const isAuthor = Boolean(currentUserId && commentUserId && currentUserId === commentUserId);
                    const statusObj = isRecord(c.status) ? c.status : void 0;
                    const statusId = statusObj ? String(statusObj.idstr || statusObj.id || "") : "";
                    const text = typeof c.text === "string" ? htmlToPlainText(c.text) : "";
                    const likeCount = typeof c.like_count === "number" ? c.like_count : 0;
                    const isCommentLiked = c.liked === true;
                    const replyCount = typeof c.total_number === "number" ? c.total_number : typeof c.reply_count === "number" ? c.reply_count : 0;
                    const commentPost = {
                      key: { id: "comment_" + statusId + "_" + commentId, host },
                      createdAt: parseWeiboDate(typeof c.created_at === "string" ? c.created_at : void 0),
                      content: { format: "plain", value: text || "\uFF08\u8BC4\u8BBA\u5185\u5BB9\u4E3A\u7A7A\uFF09" },
                      url: context.origin + "/detail/" + encodeURIComponent(statusId || commentId),
                      ...commentUser ? { author: commentUser } : {},
                      actions: [
                        { action: "Reply", label: "\u56DE\u590D", enabled: true, count: replyCount },
                        {
                          action: isCommentLiked ? "Unfavourite" : "Favourite",
                          label: isCommentLiked ? "\u5DF2\u8D5E" : "\u8D5E",
                          enabled: true,
                          active: isCommentLiked,
                          count: likeCount,
                          actionToken: "comment_" + statusId + "_" + commentId
                        },
                        ...isAuthor ? [
                          {
                            action: "Delete",
                            label: "\u5220\u9664",
                            enabled: true,
                            actionToken: "comment_" + statusId + "_" + commentId
                          }
                        ] : []
                      ]
                    };
                    let quote = void 0;
                    if (statusObj) {
                      quote = mapTimelinePost(statusObj, context, currentUserId);
                      if (quote) {
                        commentPost.references = [{ type: "Quote", key: quote.key }];
                      }
                    }
                    items.push({
                      type: "post",
                      post: commentPost,
                      ...quote ? { presentation: { quotes: [quote] } } : {}
                    });
                  }
                }
              } else if (res && res.ok === -100) {
                fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
              }
            } catch (e) {
              if (isAuthenticationError(e)) throw e;
            }
          } else if (filterId === "like") {
            try {
              const url = context.origin + "/message/attitude?page=" + pageNum;
              const res = await requestJson(
                url,
                context,
                credential.cookies,
                defaultHeaders,
                true,
                true
              );
              if (res && isOkResponse(res.ok)) {
                const list = Array.isArray(res.data) ? res.data : isRecord(res.data) && Array.isArray(res.data.attitudes) ? res.data.attitudes : isRecord(res.data) && Array.isArray(res.data.data) ? res.data.data : [];
                if (list.length > 0) {
                  hasMore = true;
                  for (const a of list) {
                    if (!isRecord(a)) continue;
                    const attitudeId = String(a.idstr || a.idStr || a.id || "");
                    if (!attitudeId) continue;
                    const actor = isRecord(a.user) ? mapTimelineProfile(a.user, context) : void 0;
                    if (!actor) continue;
                    let targetPost = void 0;
                    if (isRecord(a.status)) {
                      targetPost = mapTimelinePost(a.status, context, currentUserId);
                    }
                    const createdAt = parseWeiboDate(typeof a.created_at === "string" ? a.created_at : void 0);
                    items.push({
                      type: "userList",
                      userList: {
                        key: { id: "attitude_" + attitudeId, host },
                        createdAt,
                        users: [actor],
                        message: {
                          key: { id: "attitude_msg_" + attitudeId, host },
                          createdAt,
                          icon: "Heart",
                          actor,
                          kind: "Favourite"
                        },
                        ...targetPost ? { post: targetPost } : {}
                      }
                    });
                  }
                }
              } else if (res && res.ok === -100) {
                fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
              }
            } catch (e) {
              if (isAuthenticationError(e)) throw e;
            }
          }
          const nextCursor = hasMore ? String(pageNum + 1) : void 0;
          return {
            items,
            endReached: !hasMore,
            ...nextCursor ? { olderCursor: nextCursor } : {}
          };
        },
        async badge(request, context) {
          try {
            const credential = await readCredential();
            if (!credential.cookies || !credential.cookies.some((c) => c.name === "SUB" && c.value)) {
              return { value: 0 };
            }
            const st = await getCsrfToken(context, credential.cookies).catch(() => void 0);
            const unreadUrl = context.origin + "/api/remind/unread?t=" + Date.now();
            const headers = {
              Referer: context.origin + "/"
            };
            if (st) {
              headers["X-XSRF-TOKEN"] = st;
            }
            const response = await requestJson(unreadUrl, context, credential.cookies, headers, true, true);
            if (response && isOkResponse(response.ok) && isRecord(response.data)) {
              const d = response.data;
              const mentionStatus = typeof d.mention_status === "number" ? d.mention_status : 0;
              const cmt = typeof d.cmt === "number" ? d.cmt : 0;
              const attitude = typeof d.attitude === "number" ? d.attitude : 0;
              const count = Math.min(1e4, Math.max(0, mentionStatus + cmt + attitude));
              return { value: count };
            }
          } catch {
          }
          return { value: 0 };
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
  var cachedGroups = null;
  async function fetchUserGroups(context, cookies, forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedGroups && now - cachedGroups.time < 6e4) {
      return cachedGroups.groups;
    }
    try {
      const url = context.origin + API_CONFIG_LIST_PATH;
      const res = await requestJson(url, context, cookies, {}, true, true);
      if (res && isOkResponse(res.ok) && isRecord(res.data) && Array.isArray(res.data.groups)) {
        const groups = [];
        for (const item of res.data.groups) {
          if (isRecord(item)) {
            const gid = optionalScalarText(item.gid);
            const name = optionalScalarText(item.name);
            if (gid && name) {
              groups.push({ gid, name });
            }
          }
        }
        cachedGroups = { time: now, groups };
        return groups;
      }
    } catch {
    }
    return cachedGroups ? cachedGroups.groups : [];
  }
  async function fetchTimelineFeed(path, context, cookies, cursor) {
    let url = context.origin + path;
    if (cursor) {
      url += (path.includes("?") ? "&" : "?") + "max_id=" + encodeURIComponent(cursor);
    }
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
    let rawStatuses = [];
    if (Array.isArray(data.statuses)) {
      rawStatuses = data.statuses;
    } else if (Array.isArray(data.cards)) {
      for (const card of data.cards) {
        if (isRecord(card)) {
          if (isRecord(card.mblog)) {
            rawStatuses.push(card.mblog);
          } else if (Array.isArray(card.card_group)) {
            for (const subCard of card.card_group) {
              if (isRecord(subCard) && isRecord(subCard.mblog)) {
                rawStatuses.push(subCard.mblog);
              }
            }
          }
        }
      }
    }
    const items = rawStatuses.map((status) => mapTimelineStatus(status, context)).filter((item) => item !== void 0);
    const rawCursor = data.max_id_str ?? data.max_id ?? data.next_cursor_str ?? data.next_cursor ?? data.since_id_str ?? data.since_id;
    let olderCursor = optionalScalarText(rawCursor);
    if (olderCursor === "0" || olderCursor === "0.0") {
      olderCursor = void 0;
    }
    return {
      items,
      ...olderCursor && olderCursor !== cursor && items.length > 0 ? { olderCursor } : {}
    };
  }
  function mapTimelineStatus(value, context, currentUserId) {
    if (!isRecord(value)) return void 0;
    const post = mapTimelinePost(value, context, currentUserId);
    if (!post) return void 0;
    const retweetedStatus = isRecord(value.retweeted_status) ? mapTimelinePost(value.retweeted_status, context, currentUserId) : void 0;
    return {
      type: "post",
      post,
      ...retweetedStatus ? {
        presentation: {
          quotes: [retweetedStatus]
        }
      } : {}
    };
  }
  function mapTimelinePost(value, context, currentUserId) {
    const id = optionalScalarText(value.idstr ?? value.id ?? value.mid);
    if (!id) return void 0;
    const host = accountHost(context);
    const statusText = optionalScalarText(value.raw_text) || htmlToPlainText(optionalScalarText(value.text) || "");
    const user = isRecord(value.user) ? mapTimelineProfile(value.user, context) : void 0;
    const userId = user ? user.key.id : void 0;
    const isFromMe = Boolean(currentUserId && userId && currentUserId === userId);
    const post = {
      key: { id, host },
      createdAt: parseWeiboDate(optionalScalarText(value.created_at)),
      content: { format: "plain", value: statusText || "\uFF08\u5FAE\u535A\u5185\u5BB9\u4E3A\u7A7A\uFF09" },
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
    const isLiked = Boolean(
      value.liked === true || typeof value.attitudes_status === "number" && value.attitudes_status > 0 || value.attitude_type === "heart"
    );
    const visible = isRecord(value.visible) ? value.visible : void 0;
    const canReblog = !visible || visible.type === void 0 || visible.type === 0 || visible.type === "0";
    const actions = [
      ...canReblog ? [
        {
          action: "Repost",
          label: "\u8F6C\u53D1",
          enabled: true,
          count: repostsCount
        }
      ] : [],
      {
        action: "Reply",
        label: "\u8BC4\u8BBA",
        enabled: true,
        count: repliesCount
      },
      {
        action: isLiked ? "Unfavourite" : "Favourite",
        label: isLiked ? "\u5DF2\u8D5E" : "\u8D5E",
        enabled: true,
        active: isLiked,
        count: favouritesCount
      },
      ...isFromMe ? [
        {
          action: "Delete",
          label: "\u5220\u9664",
          enabled: true
        }
      ] : []
    ];
    post.actions = actions;
    const subtitle = (optionalScalarText(value.region_name) || optionalScalarText(value.source) || "").replace(/<[^>]+>/g, "").trim();
    if (subtitle) {
      post.sourceChannel = { id: "source", name: subtitle };
    }
    if (isRecord(value.retweeted_status)) {
      const retweetId = optionalScalarText(
        value.retweeted_status.idstr ?? value.retweeted_status.id ?? value.retweeted_status.mid
      );
      if (retweetId) {
        post.references = [{ type: "Quote", key: { id: retweetId, host } }];
      }
    }
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
      const url = safeWeiboMediaUrl(rawUrl ? rawUrl.replace("mw2000", "large") : void 0);
      if (!url) continue;
      const geo = isRecord(large.geo) ? large.geo : isRecord(rawPic.geo) ? rawPic.geo : {};
      const width = optionalPositiveNumber(geo.width);
      const height = optionalPositiveNumber(geo.height);
      const picId = optionalScalarText(rawPic.pid) || `${statusId}-image-${index}`;
      const rawPreview = optionalScalarText(rawPic.url) || rawUrl;
      const previewUrl = safeWeiboMediaUrl(rawPreview ? rawPreview.replace("orj360", "mw600") : void 0) || url;
      const picType = String(rawPic.type || "");
      const videoSrc = optionalScalarText(rawPic.videoSrc);
      if ((picType === "video" || picType === "livephoto") && videoSrc) {
        const safeVideoSrc = safeWeiboMediaUrl(videoSrc);
        if (safeVideoSrc) {
          media.push({
            id: picId,
            type: "video",
            url: safeVideoSrc,
            previewUrl,
            ...width !== void 0 ? { width } : {},
            ...height !== void 0 ? { height } : {}
          });
          if (media.length >= MAX_TIMELINE_MEDIA) break;
          continue;
        }
      }
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
    if (!media.length && isRecord(status.page_info)) {
      const pageInfo = status.page_info;
      const pageType = String(pageInfo.type || "");
      const pagePic = isRecord(pageInfo.page_pic) ? pageInfo.page_pic : {};
      const pagePicUrl = safeWeiboMediaUrl(pagePic.url);
      const width = optionalPositiveNumber(pagePic.width);
      const height = optionalPositiveNumber(pagePic.height);
      if (pageType === "video") {
        const urls = isRecord(pageInfo.urls) ? pageInfo.urls : {};
        const mediaInfo = isRecord(pageInfo.media_info) ? pageInfo.media_info : {};
        const rawVideoUrl = optionalScalarText(urls.mp4_720p_mp4) || optionalScalarText(urls.mp4_hd_mp4) || optionalScalarText(urls.mp4_ld_mp4) || optionalScalarText(mediaInfo.stream_url_hd) || optionalScalarText(mediaInfo.stream_url);
        const videoUrl = safeWeiboMediaUrl(rawVideoUrl);
        if (videoUrl && pagePicUrl) {
          media.push({
            id: `${statusId}-video-0`,
            type: "video",
            url: videoUrl,
            previewUrl: pagePicUrl,
            ...width !== void 0 ? { width } : {},
            ...height !== void 0 ? { height } : {}
          });
        }
      } else if (pageType === "bigPic" && pagePicUrl) {
        media.push({
          id: `${statusId}-image-0`,
          type: "image",
          url: pagePicUrl,
          previewUrl: pagePicUrl,
          ...width !== void 0 ? { width } : {},
          ...height !== void 0 ? { height } : {}
        });
      }
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
    const allowed = host === "sinaimg.cn" || host.endsWith(".sinaimg.cn") || host === "weibocdn.com" || host.endsWith(".weibocdn.com") || host === "weibo.com" || host.endsWith(".weibo.com") || host === "sina.com.cn" || host.endsWith(".sina.com.cn") || host === "miaopai.com" || host.endsWith(".miaopai.com");
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
    if (!value) return "";
    return decodeHtmlEntities(
      value.replace(/<img[^>]*alt="([^"]+)"[^>]*>/gi, "$1").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li)>/gi, "\n").replace(/<[^>]*>/g, "").replace(/[ \t]+\n/g, "\n").trim()
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
  async function fetchSingleStatus(id, context, cookies, st) {
    let statusData = null;
    try {
      const showUrl = context.origin + "/statuses/show?id=" + encodeURIComponent(id);
      const res = await requestJson(
        showUrl,
        context,
        cookies,
        { Referer: context.origin + "/detail/" + encodeURIComponent(id) },
        false,
        true
      );
      if (res && isRecord(res.data)) {
        statusData = res.data;
      }
    } catch {
    }
    if (!statusData) {
      try {
        const detailUrl = context.origin + "/detail/" + encodeURIComponent(id);
        const res = await flare.http.request({
          method: "GET",
          url: detailUrl,
          cookies,
          headers: {
            ...DEFAULT_HEADERS,
            Referer: context.origin + "/"
          }
        });
        if (res.status === 200 && res.body) {
          const match = /\$render_data\s*=\s*(\[\{.*?\}\])\[0\]\s*\|\|\s*\{/s.exec(res.body);
          if (match) {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed) && parsed[0] && isRecord(parsed[0].status)) {
              statusData = parsed[0].status;
            }
          }
        }
      } catch {
      }
    }
    if (!statusData) return null;
    if (statusData.isLongText === true && st) {
      try {
        const extendUrl = context.origin + "/statuses/extend?id=" + encodeURIComponent(id);
        const extendRes = await requestJson(
          extendUrl,
          context,
          cookies,
          {
            "X-Xsrf-Token": st,
            "Referer": context.origin + "/detail/" + encodeURIComponent(id)
          },
          false,
          true
        );
        if (extendRes && isRecord(extendRes.data) && typeof extendRes.data.longTextContent === "string") {
          statusData.text = extendRes.data.longTextContent;
          statusData.raw_text = extendRes.data.longTextContent;
        }
      } catch {
      }
    }
    return statusData;
  }
  function mapCommentPost(c, statusId, currentUserId, context) {
    const commentId = String(c.idstr || c.id || "");
    if (!commentId) return void 0;
    const commentUser = isRecord(c.user) ? c.user : {};
    const commentUserId = String(commentUser.id || "");
    const author = {
      key: { id: commentUserId || commentId, host: accountHost(context) },
      displayName: String(commentUser.screen_name || "\u5FAE\u535A\u7528\u6237"),
      handle: String(commentUser.screen_name || "weibo"),
      avatarUrl: safeWeiboMediaUrl(commentUser.avatar_hd || commentUser.profile_image_url)
    };
    const text = typeof c.text === "string" ? htmlToPlainText(c.text) : "";
    const likeCount = typeof c.like_count === "number" ? c.like_count : 0;
    const isCommentLiked = c.liked === true;
    const replyCount = typeof c.total_number === "number" ? c.total_number : typeof c.reply_count === "number" ? c.reply_count : 0;
    const isAuthor = Boolean(commentUserId && commentUserId === currentUserId);
    const subtitle = (optionalScalarText(c.region_name) || optionalScalarText(c.source) || "").replace(/<[^>]+>/g, "").trim();
    const actions = [
      {
        action: "Reply",
        label: "\u56DE\u590D",
        enabled: true,
        count: replyCount
      },
      {
        action: isCommentLiked ? "Unfavourite" : "Favourite",
        label: isCommentLiked ? "\u5DF2\u8D5E" : "\u8D5E",
        enabled: true,
        active: isCommentLiked,
        count: likeCount,
        actionToken: "comment_" + commentId
      },
      ...isAuthor ? [
        {
          action: "Delete",
          label: "\u5220\u9664",
          enabled: true,
          actionToken: "comment_" + commentId
        }
      ] : []
    ];
    const post = {
      key: { id: "comment_" + statusId + "_" + commentId, host: accountHost(context) },
      createdAt: parseWeiboDate(typeof c.created_at === "string" ? c.created_at : void 0),
      content: { format: "plain", value: text || " " },
      author,
      replyTo: { id: statusId, host: accountHost(context) },
      actions,
      favouritesCount: likeCount,
      ...subtitle ? { sourceChannel: { id: "source", name: subtitle } } : {}
    };
    if (isRecord(c.pic)) {
      const picObj = c.pic;
      const large = isRecord(picObj.large) ? picObj.large : {};
      const rawUrl = optionalScalarText(large.url) || optionalScalarText(picObj.url);
      const url = safeWeiboMediaUrl(rawUrl);
      if (url) {
        post.media = [
          {
            id: `${commentId}-pic`,
            type: "image",
            url,
            previewUrl: safeWeiboMediaUrl(picObj.url) || url
          }
        ];
      }
    }
    return post;
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
    const summaryAuthor = {
      key: { id: "checkin-helper", host: accountHost(context) },
      displayName: "\u8D85\u8BDD\u7B7E\u5230",
      handle: "checkin",
      ...profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}
    };
    return {
      type: "post",
      post: {
        key: { id: "checkin-summary-" + await flare.crypto.uuid(), host: accountHost(context) },
        createdAt: now.toISOString(),
        author: summaryAuthor,
        content: { format: "plain", value: lines.join("\n") },
        detailType: "link",
        url: context.origin + "/"
      }
    };
  }
  var B62_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function b62Decode(str) {
    let res = 0n;
    for (let i = 0; i < str.length; i++) {
      const idx = BigInt(B62_ALPHABET.indexOf(str[i]));
      if (idx < 0n) return 0n;
      res = res * 62n + idx;
    }
    return res;
  }
  function bidToMid(bid) {
    if (!bid) return "";
    const parts = [];
    for (let i = bid.length; i > 0; i -= 4) {
      const start = Math.max(0, i - 4);
      const chunk = bid.slice(start, i);
      let val = String(b62Decode(chunk));
      if (start > 0) {
        val = val.padStart(7, "0");
      }
      parts.unshift(val);
    }
    return parts.join("");
  }
  function mergeHeaders(...sources) {
    const result = {};
    const lowerMap = /* @__PURE__ */ new Map();
    for (const src of sources) {
      if (!src) continue;
      for (const [key, value] of Object.entries(src)) {
        if (value === void 0 || value === null) continue;
        const lower = key.toLowerCase();
        const existing = lowerMap.get(lower);
        if (existing) {
          delete result[existing];
        }
        lowerMap.set(lower, key);
        result[key] = value;
      }
    }
    return result;
  }
  async function requestJson(url, context, cookies, extraHeaders = {}, allowUnauthorized = false, allowNotFound = false) {
    if (!isSameOrigin(url, context.origin)) {
      fail("Unsupported", "\u5FAE\u535A\u63A5\u53E3\u8DF3\u8F6C\u5230\u4E86\u6240\u9009\u8D26\u53F7\u7AD9\u70B9\u4E4B\u5916\uFF0C\u5DF2\u505C\u6B62\u8BF7\u6C42\u3002");
    }
    const mergedHeaders = mergeHeaders(
      DEFAULT_HEADERS,
      { "Referer": context.origin + "/" },
      extraHeaders
    );
    let response;
    try {
      response = await flare.http.request({
        method: "GET",
        url,
        cookies,
        headers: mergedHeaders
      });
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      if (allowUnauthorized || allowNotFound) return null;
      const msg = error && typeof error === "object" && "message" in error ? String(error.message) : "Flare \u65E0\u6CD5\u8FDE\u63A5\u5FAE\u535A\u63A5\u53E3\u3002";
      fail("Network", msg);
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
    const obj = requiredObject(value);
    if (obj.ok === -100) {
      fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
    }
    return obj;
  }
  var cachedSt = null;
  async function getCsrfToken(context, cookies) {
    const now = Date.now();
    if (cachedSt && cachedSt.expiresAt > now && cachedSt.token) {
      return cachedSt.token;
    }
    try {
      const config = await requestJson(context.origin + API_CONFIG_PATH, context, cookies, {}, false, true);
      if (config && isRecord(config.data) && typeof config.data.st === "string" && config.data.st) {
        cachedSt = { token: config.data.st, expiresAt: now + 5 * 60 * 1e3 };
        return config.data.st;
      }
    } catch {
    }
    const xsrfCookie = cookies.find((c) => c.name.toLowerCase() === "xsrf-token");
    if (xsrfCookie && xsrfCookie.value) {
      return xsrfCookie.value;
    }
    return "";
  }
  async function requestFormPost(url, formValues, context, cookies, extraHeaders = {}, allowNonOk = false) {
    if (!isSameOrigin(url, context.origin)) {
      fail("Unsupported", "\u5FAE\u535A\u63A5\u53E3\u8DF3\u8F6C\u5230\u4E86\u6240\u9009\u8D26\u53F7\u7AD9\u70B9\u4E4B\u5916\uFF0C\u5DF2\u505C\u6B62\u8BF7\u6C42\u3002");
    }
    const xsrfHeaders = {};
    if (formValues.st) {
      xsrfHeaders["X-Xsrf-Token"] = formValues.st;
    }
    const mergedHeaders = mergeHeaders(
      DEFAULT_HEADERS,
      {
        "Referer": context.origin + "/",
        "X-Requested-With": "XMLHttpRequest"
      },
      xsrfHeaders,
      extraHeaders
    );
    let response;
    try {
      response = await flare.http.request({
        method: "POST",
        url,
        cookies,
        headers: mergedHeaders,
        body: {
          type: "form",
          values: formValues
        }
      });
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      const msg = error && typeof error === "object" && "message" in error ? String(error.message) : "Flare \u65E0\u6CD5\u8FDE\u63A5\u5FAE\u535A\u63A5\u53E3\u3002";
      fail("Network", msg);
    }
    if (response.status === 401 || response.status === 403) {
      cachedSt = null;
      fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\u3002");
    }
    if (response.status < 200 || response.status >= 300) {
      cachedSt = null;
      fail("Remote", "\u5FAE\u535A\u63A5\u53E3\u8FD4\u56DE HTTP " + response.status + "\u3002");
    }
    let value;
    try {
      value = JSON.parse(response.body);
    } catch {
      fail("InvalidResponse", "\u5FAE\u535A\u63A5\u53E3\u6CA1\u6709\u8FD4\u56DE\u6709\u6548 JSON\u3002");
    }
    const obj = requiredObject(value);
    if (obj.ok === -100) {
      cachedSt = null;
      fail("AuthenticationRequired", "\u5FAE\u535A\u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
    }
    if (!allowNonOk && obj.ok !== void 0 && !isOkResponse(obj.ok)) {
      cachedSt = null;
      const msg = typeof obj.msg === "string" ? obj.msg : "\u5FAE\u535A\u63A5\u53E3\u64CD\u4F5C\u5931\u8D25\u3002";
      fail("Remote", msg);
    }
    return obj;
  }
  async function performLikeAction(url, form, context, cookies, isUnlike = false) {
    let st = await getCsrfToken(context, cookies);
    if (!st) {
      fail("AuthenticationRequired", "\u65E0\u6CD5\u83B7\u53D6\u5FAE\u535A\u5B89\u5168\u51ED\u8BC1 (st)\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
    }
    form.st = st;
    let res = await requestFormPost(url, form, context, cookies, {}, true);
    if (res && res.ok !== 1) {
      const msg2 = typeof res.msg === "string" ? res.msg : "";
      const isStError = msg2.includes("st") || msg2.includes("token") || msg2.includes("\u767B\u5F55") || res.ok === -100 || res.ok === 0 && !msg2;
      if (isStError) {
        cachedSt = null;
        const freshSt = await getCsrfToken(context, cookies);
        if (freshSt && freshSt !== st) {
          form.st = freshSt;
          res = await requestFormPost(url, form, context, cookies, {}, true);
        }
      }
    }
    if (!res) {
      fail("Remote", isUnlike ? "\u53D6\u6D88\u70B9\u8D5E\u5931\u8D25\u3002" : "\u70B9\u8D5E\u5931\u8D25\u3002");
    }
    if (isOkResponse(res.ok)) {
      return;
    }
    const msg = typeof res.msg === "string" ? res.msg : "";
    if (!isUnlike && (msg.includes("\u8D5E\u8FC7") || msg.includes("\u5DF2\u70B9\u8D5E") || msg.includes("\u5DF2\u8D5E") || msg.includes("exist") || msg.includes("100001"))) {
      return;
    }
    if (isUnlike && (msg.includes("\u672A\u8D5E") || msg.includes("\u672A\u70B9\u8D5E") || msg.includes("\u6CA1\u6709\u8D5E") || msg.includes("\u4E0D\u5B58\u5728"))) {
      return;
    }
    fail("Remote", msg || (isUnlike ? "\u53D6\u6D88\u70B9\u8D5E\u5931\u8D25\u3002" : "\u70B9\u8D5E\u5931\u8D25\u3002"));
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
    const handle = requiredScalarText(user.screen_name ?? user.idstr ?? user.id);
    const avatarUrl = safeWeiboMediaUrl(user.avatar_hd ?? user.profile_image_url);
    return {
      key: { id, host: accountHost(context) },
      handle,
      displayName: handle,
      ...avatarUrl ? { avatarUrl } : {}
    };
  }
  async function fetchProfileData(idOrHandle, context, cookies) {
    let userInfo = null;
    try {
      const res = await requestJson(
        context.origin + "/api/container/getIndex?type=uid&value=" + encodeURIComponent(idOrHandle),
        context,
        cookies,
        {},
        true,
        true
      );
      if (res && isRecord(res.data) && isRecord(res.data.userInfo)) {
        userInfo = res.data.userInfo;
      }
    } catch {
    }
    if (!userInfo) {
      try {
        const res = await requestJson(
          context.origin + "/api/container/getIndex?type=uid&value=" + encodeURIComponent(idOrHandle) + "&containerid=100505" + encodeURIComponent(idOrHandle),
          context,
          cookies,
          {},
          true,
          true
        );
        if (res && isRecord(res.data) && isRecord(res.data.userInfo)) {
          userInfo = res.data.userInfo;
        }
      } catch {
      }
    }
    if (userInfo) {
      const id = String(userInfo.id || idOrHandle);
      const screenName = String(userInfo.screen_name || id);
      const avatarUrl = safeWeiboMediaUrl(userInfo.avatar_hd ?? userInfo.profile_image_url);
      const description = typeof userInfo.description === "string" && userInfo.description.trim() ? { format: "plain", value: userInfo.description.trim() } : void 0;
      return {
        key: { id, host: accountHost(context) },
        handle: screenName,
        displayName: screenName,
        ...avatarUrl ? { avatarUrl } : {},
        ...description ? { description } : {},
        ...typeof userInfo.followers_count === "number" ? { followersCount: userInfo.followers_count } : {},
        ...typeof userInfo.follow_count === "number" ? { followingCount: userInfo.follow_count } : {},
        ...typeof userInfo.statuses_count === "number" ? { postsCount: userInfo.statuses_count } : {}
      };
    }
    return {
      key: { id: idOrHandle, host: accountHost(context) },
      handle: idOrHandle,
      displayName: idOrHandle
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
    if (!error) return false;
    if (isRecord(error) && error.code === "AuthenticationRequired") return true;
    if (isRecord(error.__flarePluginErrorV1) && error.__flarePluginErrorV1.code === "AuthenticationRequired") {
      return true;
    }
    return false;
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
