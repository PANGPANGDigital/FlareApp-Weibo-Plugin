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
const API_CONFIG_LIST_PATH = "/api/config/list";
const PROFILE_PATH = "/profile/info";
const TIMELINE_FRIENDS_PATH = "/feed/friends";
const TIMELINE_CIRCLE_PATH = "/feed/circle";
const TIMELINE_PRIVATE_PATH = "/feed/private";
const TIMELINE_GROUP_PATH = "/feed/group";
const FRIENDS_TIMELINE_PATH = TIMELINE_FRIENDS_PATH;
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
      async begin(_request, _context) {
        return {
          type: "webCookie",
          startUrl: "https://m.weibo.cn/login?backURL=https%3A%2F%2Fm.weibo.cn%2F",
        };
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
        const uid = configData.uid ? String(configData.uid) : "";

        let user: Record<string, unknown> | null = null;
        if (isRecord(configData.user)) {
          user = configData.user;
        }

        // Fetch real user info (nickname & avatar) from /api/container/getIndex
        if (uid && (!user || !user.avatar_hd || !user.screen_name)) {
          try {
            const userIndex = await requestJson(
              context.origin + "/api/container/getIndex?type=uid&value=" + encodeURIComponent(uid),
              context,
              cookies,
              {},
              true,
              true,
            );
            if (userIndex && isRecord(userIndex.data) && isRecord(userIndex.data.userInfo)) {
              user = {
                ...(user || {}),
                ...userIndex.data.userInfo,
              };
            }
          } catch {
            // fallback
          }
        }

        if (uid && (!user || !user.avatar_hd || !user.screen_name)) {
          try {
            const userIndex = await requestJson(
              context.origin +
                "/api/container/getIndex?type=uid&value=" +
                encodeURIComponent(uid) +
                "&containerid=100505" +
                encodeURIComponent(uid),
              context,
              cookies,
              {},
              true,
              true,
            );
            if (userIndex && isRecord(userIndex.data) && isRecord(userIndex.data.userInfo)) {
              user = {
                ...(user || {}),
                ...userIndex.data.userInfo,
              };
            }
          } catch {
            // fallback
          }
        }

        if (!user && uid) {
          user = {
            id: uid,
            screen_name: configData.screen_name ? String(configData.screen_name) : uid,
          };
        }

        if (!user || (!user.id && !user.idstr)) {
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
            capabilities: {
              "flare.datasource.timeline/v1": ["page"],
              "flare.datasource.tab-catalog/v1": ["page"],
              "flare.datasource.post/v1": ["detail", "context", "mutate", "delete"],
              "flare.datasource.compose/v1": ["publish"],
              "flare.datasource.profile/v1": ["byId", "byHandle"],
            },
          },
        };
      },
    },
  },
  capabilities: {
    timeline: {
      async page(request, context) {
        const credential = await readCredential();

        // Self-heal avatar & nickname if missing from initial login
        if (!credential.profile.avatarUrl && credential.profile.key.id) {
          try {
            const userIndex = await requestJson(
              context.origin + "/api/container/getIndex?type=uid&value=" + encodeURIComponent(credential.profile.key.id),
              context,
              credential.cookies,
              {},
              true,
              true,
            );
            if (userIndex && isRecord(userIndex.data) && isRecord(userIndex.data.userInfo)) {
              const uInfo = userIndex.data.userInfo;
              const avatarUrl = safeWeiboMediaUrl(uInfo.avatar_hd ?? uInfo.profile_image_url);
              const screenName = requiredScalarText(uInfo.screen_name ?? credential.profile.displayName);
              if (avatarUrl || screenName) {
                credential.profile = {
                  ...credential.profile,
                  ...(screenName ? { displayName: screenName, handle: screenName } : {}),
                  ...(avatarUrl ? { avatarUrl } : {}),
                };
                await flare.credential.replace(credential as unknown as JsonValue);
              }
            }
          } catch {
            // non-fatal
          }
        }

        const timelineId = request.timelineId || "checkin";
        if (request.page.direction !== "refresh" && request.page.direction !== "older") {
          return { items: [], endReached: true };
        }

        const items: TimelineItemV1[] = [];
        const isTopOrRefresh =
          request.page.direction === "refresh" ||
          !request.page.cursor;

        // Super topic checkin runs exclusively on the main "checkin" timeline
        if (timelineId === "checkin" && isTopOrRefresh) {
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

        // Determine feed endpoint based on timelineId
        let feedEndpoint = TIMELINE_FRIENDS_PATH;
        if (timelineId === "friends") {
          feedEndpoint = TIMELINE_CIRCLE_PATH;
        } else if (timelineId === "private") {
          feedEndpoint = TIMELINE_PRIVATE_PATH;
        } else if (timelineId === "special") {
          const groups = await fetchUserGroups(context, credential.cookies);
          const specialGroup = groups.find((g) => g.name === "特别关注" || g.name.includes("特别关注"));
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

        const cursor = request.page.direction === "older" ? request.page.cursor : undefined;
        const feedPage = await fetchTimelineFeed(
          feedEndpoint,
          context,
          credential.cookies,
          cursor,
        );
        items.push(...feedPage.items);

        return {
          items,
          endReached: !feedPage.olderCursor,
          ...(feedPage.olderCursor ? { olderCursor: feedPage.olderCursor } : {}),
        };
      },
    },

    tabCatalog: {
      async page(_request, context) {
        let dynamicGroups: WeiboGroupInfo[] = [];
        try {
          const credential = await readCredential();
          dynamicGroups = await fetchUserGroups(context, credential.cookies);
        } catch {
          // guest or unauthenticated
        }

        const timelineItems: TimelineDescriptorV1[] = [
          { id: "checkin", title: { value: "最新微博Enhance" }, icon: "Home" },
          { id: "friends", title: { value: "好友圈" }, icon: "Follow" },
          { id: "private", title: { value: "悄悄关注" }, icon: "Bookmark" },
        ];

        let hasSpecial = false;
        for (const g of dynamicGroups) {
          if (g.name === "特别关注" || g.name.includes("特别关注")) {
            hasSpecial = true;
            timelineItems.push({
              id: "special",
              title: { value: g.name },
              icon: "Featured",
            });
          } else {
            const safeGid = g.gid.replace(/[^0-9a-zA-Z_.-]/g, "_");
            timelineItems.push({
              id: "group-" + safeGid,
              title: { value: g.name },
              icon: "List",
              parameters: { gid: g.gid },
            });
          }
        }

        if (!hasSpecial) {
          timelineItems.push({
            id: "special",
            title: { value: "特别关注" },
            icon: "Featured",
          });
        }

        return {
          items: [
            {
              id: "weibo_groups",
              title: { value: "微博分组" },
              timelines: {
                items: timelineItems,
                endReached: true,
              },
            },
          ],
          endReached: true,
        };
      },
    },

    post: {
      async detail(request, context) {
        const credential = await readCredential();
        const id = request.key.id;
        const st = await getCsrfToken(context, credential.cookies).catch(() => undefined);
        const data = await fetchSingleStatus(id, context, credential.cookies, st);
        if (!data) {
          fail("NotFound", "微博不存在或已被删除。");
        }
        const post = mapTimelinePost(data, context, credential.profile.key.id);
        if (!post) {
          fail("NotFound", "无法解析该微博。");
        }
        const retweet = isRecord(data.retweeted_status)
          ? mapTimelinePost(data.retweeted_status as Record<string, unknown>, context, credential.profile.key.id)
          : undefined;
        return {
          post,
          ...(retweet ? {
            presentation: {
              quotes: [retweet],
              repost: retweet,
            },
          } : {}),
        };
      },

      async context(request, context) {
        const credential = await readCredential();
        const id = request.key.id;
        const cursor = request.page.cursor;
        const currentUserId = credential.profile.key.id;
        const items: TimelineItemV1[] = [];

        // On first page / refresh, prepend the root status post so Flare renders it at the top of the detail screen
        if (!cursor) {
          try {
            const st = await getCsrfToken(context, credential.cookies).catch(() => undefined);
            const statusData = await fetchSingleStatus(id, context, credential.cookies, st);
            if (statusData) {
              const rootPost = mapTimelinePost(statusData, context, currentUserId);
              if (rootPost) {
                const retweet = isRecord(statusData.retweeted_status)
                  ? mapTimelinePost(statusData.retweeted_status as Record<string, unknown>, context, currentUserId)
                  : undefined;
                items.push({
                  type: "post",
                  post: rootPost,
                  ...(retweet ? {
                    presentation: {
                      quotes: [retweet],
                      repost: retweet,
                    },
                  } : {}),
                });
              }
            }
          } catch {
            // non-fatal, proceed to comments
          }
        }

        let rootComments: unknown[] = [];
        let nextCursor: string | undefined = undefined;

        // Try hotflow first with detail page referer
        try {
          let url =
            context.origin +
            "/comments/hotflow?id=" +
            encodeURIComponent(id) +
            "&mid=" +
            encodeURIComponent(id) +
            "&max_id_type=0";
          if (cursor && !cursor.startsWith("page_")) {
            url += "&max_id=" + encodeURIComponent(cursor);
          }
          const response = await requestJson(
            url,
            context,
            credential.cookies,
            { Referer: context.origin + "/detail/" + encodeURIComponent(id) },
            false,
            true,
          );
          if (response && isOkResponse(response.ok) && isRecord(response.data)) {
            const data = response.data as Record<string, unknown>;
            if (Array.isArray(data.data)) {
              rootComments = data.data;
            } else if (Array.isArray(data.root_comments)) {
              rootComments = data.root_comments;
            }
            const rawMaxId = data.max_id;
            if (
              (typeof rawMaxId === "number" || typeof rawMaxId === "string") &&
              String(rawMaxId) !== "0" &&
              String(rawMaxId) !== cursor
            ) {
              nextCursor = String(rawMaxId);
            }
          }
        } catch {
          // ignore, fallback below
        }

        // If hotflow had no results, fallback to /api/comments/show
        if (!rootComments.length && !cursor) {
          try {
            const showUrl =
              context.origin +
              "/api/comments/show?id=" +
              encodeURIComponent(id) +
              "&page=1";
            const response = await requestJson(
              showUrl,
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(id) },
              false,
              true,
            );
            if (response && isOkResponse(response.ok) && isRecord(response.data)) {
              const data = response.data as Record<string, unknown>;
              if (Array.isArray(data.data)) {
                rootComments = data.data;
              }
              const rawMax = data.max;
              if (typeof rawMax === "number" && rawMax > 1) {
                nextCursor = "page_2";
              }
            }
          } catch {
            // ignore
          }
        } else if (!rootComments.length && cursor && cursor.startsWith("page_")) {
          const pageNum = parseInt(cursor.replace("page_", ""), 10) || 1;
          try {
            const showUrl =
              context.origin +
              "/api/comments/show?id=" +
              encodeURIComponent(id) +
              "&page=" +
              pageNum;
            const response = await requestJson(
              showUrl,
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(id) },
              false,
              true,
            );
            if (response && isOkResponse(response.ok) && isRecord(response.data)) {
              const data = response.data as Record<string, unknown>;
              if (Array.isArray(data.data)) {
                rootComments = data.data;
              }
              const rawMax = data.max;
              if (typeof rawMax === "number" && pageNum < rawMax) {
                nextCursor = "page_" + (pageNum + 1);
              }
            }
          } catch {
            // ignore
          }
        }

        for (const c of rootComments) {
          if (!isRecord(c)) continue;
          const commentPost = mapCommentPost(c, id, currentUserId, context);
          if (commentPost) {
            items.push({
              type: "post",
              post: commentPost,
            });
          }
        }

        return {
          items,
          endReached: !nextCursor,
          ...(nextCursor ? { olderCursor: nextCursor } : {}),
        };
      },

      async mutate(request, context) {
        const credential = await readCredential();
        const st = await getCsrfToken(context, credential.cookies);
        const rawId = request.key.id;
        const isComment = rawId.startsWith("comment_") || rawId.startsWith("comment-");

        let statusId = rawId;
        let commentId = "";
        if (isComment) {
          const parts = rawId.split("_");
          if (parts.length >= 3) {
            statusId = parts[1];
            commentId = parts[2];
          } else {
            commentId = rawId.replace(/^comment[-_]/, "");
            statusId = commentId;
          }
        }

        if (isComment) {
          // Comment action: Favourite / Unfavourite, Delete
          if (request.action === "Favourite") {
            await requestFormPost(
              context.origin + "/api/likes/update",
              { id: commentId, type: "comment", st },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );
          } else if (request.action === "Unfavourite") {
            await requestFormPost(
              context.origin + "/api/likes/destroy",
              { id: commentId, type: "comment", st },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );
          } else if (request.action === "Delete") {
            await requestFormPost(
              context.origin + "/comments/destroy",
              { cid: commentId, st },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );
            return { type: "deleted" };
          }

          const isNowLiked = request.action === "Favourite";
          const updatedPost: PostV1 = {
            key: request.key,
            createdAt: new Date().toISOString(),
            content: { format: "plain", value: "" },
            replyTo: { id: statusId, host: accountHost(context) },
            actions: [
              {
                action: "Reply",
                label: "回复",
                enabled: true,
              },
              {
                action: isNowLiked ? "Unfavourite" : "Favourite",
                label: isNowLiked ? "已赞" : "赞",
                enabled: true,
                active: isNowLiked,
                actionToken: "comment_" + commentId,
              },
            ],
          };
          return { type: "updatedPost", post: updatedPost };
        } else {
          // Status action: Favourite / Unfavourite, Repost, Bookmark / Unbookmark, Delete
          if (request.action === "Favourite") {
            await requestFormPost(
              context.origin + "/api/attitudes/create",
              { id: statusId, attitude: "heart", st },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );
          } else if (request.action === "Unfavourite") {
            await requestFormPost(
              context.origin + "/api/attitudes/destroy",
              { id: statusId, attitude: "heart", st },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );
          } else if (request.action === "Repost") {
            const content = request.parameters?.content || "转发微博";
            await requestFormPost(
              context.origin + "/api/statuses/repost",
              { id: statusId, mid: statusId, content, st },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );
          } else if (request.action === "Bookmark") {
            await requestFormPost(
              context.origin + "/api/statuses/createfav",
              { id: statusId, st },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );
          } else if (request.action === "Unbookmark") {
            await requestFormPost(
              context.origin + "/api/statuses/destroyfav",
              { id: statusId, st },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );
          } else if (request.action === "Delete") {
            await requestFormPost(
              context.origin + "/profile/delMyblog",
              { mid: statusId, st },
              context,
              credential.cookies,
              { Referer: context.origin + "/" },
            );
            return { type: "deleted" };
          }

          try {
            const updatedData = await fetchSingleStatus(statusId, context, credential.cookies, st);
            if (updatedData) {
              const updated = mapTimelinePost(updatedData, context, credential.profile.key.id);
              if (updated) {
                if (request.action === "Favourite") {
                  updated.favouritesCount = (updated.favouritesCount || 0) + 1;
                  updated.actions = (updated.actions || []).map((a) =>
                    a.action === "Favourite"
                      ? { ...a, action: "Unfavourite" as const, label: "已赞", active: true, count: updated.favouritesCount }
                      : a,
                  );
                } else if (request.action === "Unfavourite") {
                  updated.favouritesCount = Math.max(0, (updated.favouritesCount || 1) - 1);
                  updated.actions = (updated.actions || []).map((a) =>
                    a.action === "Unfavourite"
                      ? { ...a, action: "Favourite" as const, label: "赞", active: false, count: updated.favouritesCount }
                      : a,
                  );
                } else if (request.action === "Repost") {
                  updated.repostsCount = (updated.repostsCount || 0) + 1;
                  updated.actions = (updated.actions || []).map((a) =>
                    a.action === "Repost"
                      ? { ...a, count: updated.repostsCount }
                      : a,
                  );
                } else if (request.action === "Bookmark") {
                  updated.actions = (updated.actions || []).map((a) =>
                    a.action === "Bookmark"
                      ? { ...a, action: "Unbookmark" as const, label: "已收藏", active: true }
                      : a,
                  );
                } else if (request.action === "Unbookmark") {
                  updated.actions = (updated.actions || []).map((a) =>
                    a.action === "Unbookmark"
                      ? { ...a, action: "Bookmark" as const, label: "收藏", active: false }
                      : a,
                  );
                }
                return { type: "updatedPost", post: updated };
              }
            }
          } catch {
            // fallback
          }

          const isLiked = request.action === "Favourite";
          const fallbackActions: ActionDescriptorV1[] = [
            { action: "Repost", label: "转发", enabled: true },
            { action: "Reply", label: "评论", enabled: true },
            {
              action: isLiked ? "Unfavourite" : "Favourite",
              label: isLiked ? "已赞" : "赞",
              enabled: true,
              active: isLiked,
            },
          ];
          const fallbackPost: PostV1 = {
            key: request.key,
            createdAt: new Date().toISOString(),
            content: { format: "plain", value: "" },
            actions: fallbackActions,
          };
          return { type: "updatedPost", post: fallbackPost };
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
            { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
          );
        } else {
          await requestFormPost(
            context.origin + "/profile/delMyblog",
            { mid: rawId, st },
            context,
            credential.cookies,
            { Referer: context.origin + "/" },
          );
        }
        return { type: "deleted" };
      },
    },

    compose: {
      async publish(request, context) {
        const credential = await readCredential();
        const st = await getCsrfToken(context, credential.cookies);

        if (request.replyTo) {
          const rawId = request.replyTo.id;
          if (rawId.startsWith("comment_") || rawId.startsWith("comment-")) {
            // Replying to a comment
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
                st,
              },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );

            if (!res || !isOkResponse(res.ok) || !isRecord(res.data)) {
              const msg = isRecord(res) && typeof res.msg === "string" ? res.msg : "回复发布失败。";
              fail("Remote", msg);
            }

            const commentData = res.data as Record<string, unknown>;
            const mapped = mapCommentPost(commentData, statusId, credential.profile.key.id, context);
            if (mapped) {
              return { post: mapped };
            }

            const post: PostV1 = {
              key: { id: "comment_" + statusId + "_" + (commentData.idstr || commentData.id || String(Date.now())), host: accountHost(context) },
              createdAt: parseWeiboDate(typeof commentData.created_at === "string" ? commentData.created_at : undefined),
              content: { format: "plain", value: request.text },
              author: credential.profile,
              replyTo: request.replyTo,
            };
            return { post };
          } else {
            // Commenting on a status
            const statusId = rawId;
            const res = await requestFormPost(
              context.origin + "/api/comments/create",
              {
                id: statusId,
                mid: statusId,
                content: request.text,
                st,
              },
              context,
              credential.cookies,
              { Referer: context.origin + "/detail/" + encodeURIComponent(statusId) },
            );

            if (!res || !isOkResponse(res.ok) || !isRecord(res.data)) {
              const msg = isRecord(res) && typeof res.msg === "string" ? res.msg : "评论发布失败。";
              fail("Remote", msg);
            }

            const commentData = res.data as Record<string, unknown>;
            const mapped = mapCommentPost(commentData, statusId, credential.profile.key.id, context);
            if (mapped) {
              return { post: mapped };
            }

            const post: PostV1 = {
              key: { id: "comment_" + statusId + "_" + (commentData.idstr || commentData.id || String(Date.now())), host: accountHost(context) },
              createdAt: parseWeiboDate(typeof commentData.created_at === "string" ? commentData.created_at : undefined),
              content: { format: "plain", value: request.text },
              author: credential.profile,
              replyTo: request.replyTo,
            };
            return { post };
          }
        } else {
          // New status
          const formValues: Record<string, string> = {
            content: request.text,
            st,
          };
          if (request.visibility === "followers") {
            formValues.visible = "6";
          }

          const res = await requestFormPost(
            context.origin + "/api/statuses/update",
            formValues,
            context,
            credential.cookies,
            { Referer: context.origin + "/" },
          );

          if (!res || !isOkResponse(res.ok) || !isRecord(res.data)) {
            const msg = isRecord(res) && typeof res.msg === "string" ? res.msg : "微博发布失败。";
            fail("Remote", msg);
          }

          const statusData = res.data as Record<string, unknown>;
          const post = mapTimelinePost(statusData, context, credential.profile.key.id);
          if (!post) {
            fail("Remote", "无法解析新发布的微博。");
          }

          return { post };
        }
      },
    },

    profile: {
      async byId(request, context) {
        const credential = await readCredential();
        return await fetchProfileData(request.key.id, context, credential.cookies);
      },
      async byHandle(request, context) {
        const credential = await readCredential();
        return await fetchProfileData(request.handle, context, credential.cookies);
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

interface WeiboGroupInfo {
  gid: string;
  name: string;
}

let cachedGroups: { time: number; groups: WeiboGroupInfo[] } | null = null;

async function fetchUserGroups(
  context: PluginInvocationContextV1,
  cookies: CookiePair[],
  forceRefresh = false,
): Promise<WeiboGroupInfo[]> {
  const now = Date.now();
  if (!forceRefresh && cachedGroups && now - cachedGroups.time < 60_000) {
    return cachedGroups.groups;
  }
  try {
    const url = context.origin + API_CONFIG_LIST_PATH;
    const res = await requestJson(url, context, cookies, {}, true, true);
    if (res && isOkResponse(res.ok) && isRecord(res.data) && Array.isArray(res.data.groups)) {
      const groups: WeiboGroupInfo[] = [];
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
    // non-fatal
  }
  return cachedGroups ? cachedGroups.groups : [];
}

async function fetchTimelineFeed(
  path: string,
  context: PluginInvocationContextV1,
  cookies: CookiePair[],
  cursor?: string,
): Promise<{ items: TimelineItemV1[]; olderCursor?: string }> {
  let url = context.origin + path;
  if (cursor) {
    url += (path.includes("?") ? "&" : "?") + "max_id=" + encodeURIComponent(cursor);
  }
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
  let rawStatuses: unknown[] = [];
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

  const items = rawStatuses
    .map((status) => mapTimelineStatus(status, context))
    .filter((item): item is TimelineItemV1 => item !== undefined);
  const rawCursor =
    data.max_id_str ??
    data.max_id ??
    data.next_cursor_str ??
    data.next_cursor ??
    data.since_id_str ??
    data.since_id;
  let olderCursor = optionalScalarText(rawCursor);
  if (olderCursor === "0" || olderCursor === "0.0") {
    olderCursor = undefined;
  }

  return {
    items,
    ...(olderCursor && olderCursor !== cursor && items.length > 0 ? { olderCursor } : {}),
  };
}

function mapTimelineStatus(
  value: unknown,
  context: PluginInvocationContextV1,
  currentUserId?: string,
): TimelineItemV1 | undefined {
  if (!isRecord(value)) return undefined;
  const post = mapTimelinePost(value, context, currentUserId);
  if (!post) return undefined;

  const retweetedStatus = isRecord(value.retweeted_status)
    ? mapTimelinePost(value.retweeted_status, context, currentUserId)
    : undefined;
  return {
    type: "post",
    post,
    ...(retweetedStatus
      ? {
          presentation: {
            quotes: [retweetedStatus],
            repost: retweetedStatus,
          },
        }
      : {}),
  };
}

function mapTimelinePost(
  value: Record<string, unknown>,
  context: PluginInvocationContextV1,
  currentUserId?: string,
): PostV1 | undefined {
  const id = optionalScalarText(value.idstr ?? value.id ?? value.mid);
  if (!id) return undefined;

  const host = accountHost(context);
  const statusText = optionalScalarText(value.raw_text) || htmlToPlainText(optionalScalarText(value.text) || "");
  const user = isRecord(value.user) ? mapTimelineProfile(value.user, context) : undefined;
  const userId = user ? user.key.id : undefined;
  const isFromMe = Boolean(currentUserId && userId && currentUserId === userId);

  const post: PostV1 = {
    key: { id, host },
    createdAt: parseWeiboDate(optionalScalarText(value.created_at)),
    content: { format: "plain", value: statusText || "（微博内容为空）" },
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

  const isLiked = Boolean(
    value.liked === true ||
    (typeof value.attitudes_status === "number" && value.attitudes_status > 0) ||
    value.attitude_type === "heart"
  );

  const visible = isRecord(value.visible) ? (value.visible as Record<string, unknown>) : undefined;
  const canReblog = !visible || visible.type === undefined || visible.type === 0 || visible.type === "0";

  const actions: ActionDescriptorV1[] = [
    ...(canReblog
      ? [
          {
            action: "Repost" as const,
            label: "转发",
            enabled: true,
            count: repostsCount,
          },
        ]
      : []),
    {
      action: "Reply" as const,
      label: "评论",
      enabled: true,
      count: repliesCount,
    },
    {
      action: isLiked ? ("Unfavourite" as const) : ("Favourite" as const),
      label: isLiked ? "已赞" : "赞",
      enabled: true,
      active: isLiked,
      count: favouritesCount,
    },
    ...(isFromMe
      ? [
          {
            action: "Delete" as const,
            label: "删除",
            enabled: true,
          },
        ]
      : []),
  ];
  post.actions = actions;

  const subtitle = (
    optionalScalarText(value.region_name) ||
    optionalScalarText(value.source) ||
    ""
  )
    .replace(/<[^>]+>/g, "")
    .trim();
  if (subtitle) {
    post.sourceChannel = { id: "source", name: subtitle };
  }

  if (isRecord(value.retweeted_status)) {
    const retweetId = optionalScalarText(
      (value.retweeted_status as Record<string, unknown>).idstr ??
        (value.retweeted_status as Record<string, unknown>).id ??
        (value.retweeted_status as Record<string, unknown>).mid,
    );
    if (retweetId) {
      post.references = [{ type: "Quote", key: { id: retweetId, host } }];
    }
  }

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
    const large = isRecord(rawPic.large) ? (rawPic.large as Record<string, unknown>) : {};
    const rawUrl = optionalScalarText(large.url) || optionalScalarText(rawPic.url);
    const url = safeWeiboMediaUrl(rawUrl ? rawUrl.replace("mw2000", "large") : undefined);
    if (!url) continue;

    const geo = isRecord(large.geo) ? (large.geo as Record<string, unknown>) : isRecord(rawPic.geo) ? (rawPic.geo as Record<string, unknown>) : {};
    const width = optionalPositiveNumber(geo.width);
    const height = optionalPositiveNumber(geo.height);
    const picId = optionalScalarText(rawPic.pid) || `${statusId}-image-${index}`;

    const rawPreview = optionalScalarText(rawPic.url) || rawUrl;
    const previewUrl = safeWeiboMediaUrl(rawPreview ? rawPreview.replace("orj360", "mw600") : undefined) || url;

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
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
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
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
    if (media.length >= MAX_TIMELINE_MEDIA) break;
  }

  // Fallback to page_info if no pics found (handles single video & bigPic)
  if (!media.length && isRecord(status.page_info)) {
    const pageInfo = status.page_info as Record<string, unknown>;
    const pageType = String(pageInfo.type || "");
    const pagePic = isRecord(pageInfo.page_pic) ? (pageInfo.page_pic as Record<string, unknown>) : {};
    const pagePicUrl = safeWeiboMediaUrl(pagePic.url);
    const width = optionalPositiveNumber(pagePic.width);
    const height = optionalPositiveNumber(pagePic.height);

    if (pageType === "video") {
      const urls = isRecord(pageInfo.urls) ? (pageInfo.urls as Record<string, unknown>) : {};
      const mediaInfo = isRecord(pageInfo.media_info) ? (pageInfo.media_info as Record<string, unknown>) : {};
      const rawVideoUrl =
        optionalScalarText(urls.mp4_720p_mp4) ||
        optionalScalarText(urls.mp4_hd_mp4) ||
        optionalScalarText(urls.mp4_ld_mp4) ||
        optionalScalarText(mediaInfo.stream_url_hd) ||
        optionalScalarText(mediaInfo.stream_url);
      const videoUrl = safeWeiboMediaUrl(rawVideoUrl);
      if (videoUrl && pagePicUrl) {
        media.push({
          id: `${statusId}-video-0`,
          type: "video",
          url: videoUrl,
          previewUrl: pagePicUrl,
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        });
      }
    } else if (pageType === "bigPic" && pagePicUrl) {
      media.push({
        id: `${statusId}-image-0`,
        type: "image",
        url: pagePicUrl,
        previewUrl: pagePicUrl,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
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
  const allowed =
    host === "sinaimg.cn" ||
    host.endsWith(".sinaimg.cn") ||
    host === "weibocdn.com" ||
    host.endsWith(".weibocdn.com") ||
    host === "weibo.com" ||
    host.endsWith(".weibo.com") ||
    host === "sina.com.cn" ||
    host.endsWith(".sina.com.cn") ||
    host === "miaopai.com" ||
    host.endsWith(".miaopai.com");
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
  if (!value) return "";
  return decodeHtmlEntities(
    value
      .replace(/<img[^>]*alt="([^"]+)"[^>]*>/gi, "$1")
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

async function fetchSingleStatus(
  id: string,
  context: PluginInvocationContextV1,
  cookies: CookiePair[],
  st?: string,
): Promise<Record<string, unknown> | null> {
  let statusData: Record<string, unknown> | null = null;
  try {
    const showUrl = context.origin + "/statuses/show?id=" + encodeURIComponent(id);
    const res = await requestJson(
      showUrl,
      context,
      cookies,
      { Referer: context.origin + "/detail/" + encodeURIComponent(id) },
      false,
      true,
    );
    if (res && isRecord(res.data)) {
      statusData = res.data as Record<string, unknown>;
    }
  } catch {
    // fallback to detail page below
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
          Referer: context.origin + "/",
        },
      });
      if (res.status === 200 && res.body) {
        const match = /\$render_data\s*=\s*(\[\{.*?\}\])\[0\]\s*\|\|\s*\{/s.exec(res.body);
        if (match) {
          const parsed = JSON.parse(match[1]);
          if (Array.isArray(parsed) && parsed[0] && isRecord(parsed[0].status)) {
            statusData = parsed[0].status as Record<string, unknown>;
          }
        }
      }
    } catch {
      // ignore
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
          "Referer": context.origin + "/detail/" + encodeURIComponent(id),
        },
        false,
        true,
      );
      if (extendRes && isRecord(extendRes.data) && typeof extendRes.data.longTextContent === "string") {
        statusData.text = extendRes.data.longTextContent;
        statusData.raw_text = extendRes.data.longTextContent;
      }
    } catch {
      // ignore
    }
  }

  return statusData;
}

function mapCommentPost(
  c: Record<string, unknown>,
  statusId: string,
  currentUserId: string,
  context: PluginInvocationContextV1,
): PostV1 | undefined {
  const commentId = String(c.idstr || c.id || "");
  if (!commentId) return undefined;

  const commentUser = isRecord(c.user) ? (c.user as Record<string, unknown>) : {};
  const commentUserId = String(commentUser.id || "");
  const author: ProfileV1 = {
    key: { id: commentUserId || commentId, host: accountHost(context) },
    displayName: String(commentUser.screen_name || "微博用户"),
    handle: String(commentUser.screen_name || "weibo"),
    avatarUrl: safeWeiboMediaUrl(commentUser.avatar_hd || commentUser.profile_image_url),
  };

  const text = typeof c.text === "string" ? htmlToPlainText(c.text) : "";
  const likeCount = typeof c.like_count === "number" ? c.like_count : 0;
  const isCommentLiked = c.liked === true;
  const replyCount =
    typeof c.total_number === "number"
      ? c.total_number
      : typeof c.reply_count === "number"
        ? c.reply_count
        : 0;
  const isAuthor = Boolean(commentUserId && commentUserId === currentUserId);

  const subtitle = (
    optionalScalarText(c.region_name) ||
    optionalScalarText(c.source) ||
    ""
  )
    .replace(/<[^>]+>/g, "")
    .trim();

  const actions: ActionDescriptorV1[] = [
    {
      action: "Reply",
      label: "回复",
      enabled: true,
      count: replyCount,
    },
    {
      action: isCommentLiked ? "Unfavourite" : "Favourite",
      label: isCommentLiked ? "已赞" : "赞",
      enabled: true,
      active: isCommentLiked,
      count: likeCount,
      actionToken: "comment_" + commentId,
    },
    ...(isAuthor
      ? [
          {
            action: "Delete" as const,
            label: "删除",
            enabled: true,
            actionToken: "comment_" + commentId,
          },
        ]
      : []),
  ];

  const post: PostV1 = {
    key: { id: "comment_" + statusId + "_" + commentId, host: accountHost(context) },
    createdAt: parseWeiboDate(typeof c.created_at === "string" ? c.created_at : undefined),
    content: { format: "plain", value: text || " " },
    author,
    replyTo: { id: statusId, host: accountHost(context) },
    actions,
    favouritesCount: likeCount,
    ...(subtitle ? { sourceChannel: { id: "source", name: subtitle } } : {}),
  };

  if (isRecord(c.pic)) {
    const picObj = c.pic as Record<string, unknown>;
    const large = isRecord(picObj.large) ? (picObj.large as Record<string, unknown>) : {};
    const rawUrl = optionalScalarText(large.url) || optionalScalarText(picObj.url);
    const url = safeWeiboMediaUrl(rawUrl);
    if (url) {
      post.media = [
        {
          id: `${commentId}-pic`,
          type: "image",
          url,
          previewUrl: safeWeiboMediaUrl(picObj.url) || url,
        },
      ];
    }
  }

  return post;
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

  const summaryAuthor: ProfileV1 = {
    key: { id: "checkin-helper", host: accountHost(context) },
    displayName: "超话签到",
    handle: "checkin",
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };

  return {
    type: "post",
    post: {
      key: { id: "checkin-summary-" + (await flare.crypto.uuid()), host: accountHost(context) },
      createdAt: now.toISOString(),
      author: summaryAuthor,
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

let cachedSt: { token: string; expiresAt: number } | null = null;

async function getCsrfToken(context: PluginInvocationContextV1, cookies: CookiePair[]): Promise<string> {
  const now = Date.now();
  if (cachedSt && cachedSt.expiresAt > now && cachedSt.token) {
    return cachedSt.token;
  }
  try {
    const config = await requestJson(context.origin + API_CONFIG_PATH, context, cookies, {}, false, true);
    if (config && isRecord(config.data) && typeof config.data.st === "string" && config.data.st) {
      cachedSt = { token: config.data.st, expiresAt: now + 5 * 60 * 1000 };
      return config.data.st;
    }
  } catch {
    // fallback
  }
  const xsrfCookie = cookies.find((c) => c.name.toLowerCase() === "xsrf-token");
  if (xsrfCookie && xsrfCookie.value) {
    return xsrfCookie.value;
  }
  return "";
}

async function requestFormPost(
  url: string,
  formValues: Record<string, string>,
  context: PluginInvocationContextV1,
  cookies: CookiePair[],
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown> | null> {
  if (!isSameOrigin(url, context.origin)) {
    fail("Unsupported", "微博接口跳转到了所选账号站点之外，已停止请求。");
  }

  const xsrfHeaders: Record<string, string> = {};
  if (formValues.st) {
    xsrfHeaders["X-Xsrf-Token"] = formValues.st;
    xsrfHeaders["X-XSRF-TOKEN"] = formValues.st;
  }

  let response: HttpResponseV1;
  try {
    response = await flare.http.request({
      method: "POST",
      url,
      cookies,
      headers: {
        ...DEFAULT_HEADERS,
        "Referer": extraHeaders["Referer"] || (context.origin + "/"),
        "X-Requested-With": "XMLHttpRequest",
        ...xsrfHeaders,
        ...extraHeaders,
      },
      body: {
        type: "form",
        values: formValues,
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "host.unavailable") {
      fail("Network", "Flare 无法连接微博接口。");
    }
    throw error;
  }

  if (response.status === 401 || response.status === 403) {
    cachedSt = null;
    fail("AuthenticationRequired", "微博登录状态已失效。");
  }
  if (response.status < 200 || response.status >= 300) {
    cachedSt = null;
    fail("Remote", "微博接口返回 HTTP " + response.status + "。");
  }

  try {
    const value = JSON.parse(response.body);
    if (isRecord(value)) {
      if (value.ok !== undefined && !isOkResponse(value.ok)) {
        cachedSt = null;
        const msg = typeof value.msg === "string" ? value.msg : "微博接口操作失败。";
        fail("Remote", msg);
      }
      return value;
    }
    return null;
  } catch (err) {
    if (isRecord(err) && typeof err.code === "string") throw err;
    return null;
  }
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
  const handle = requiredScalarText(user.screen_name ?? user.idstr ?? user.id);
  const avatarUrl = safeWeiboMediaUrl(user.avatar_hd ?? user.profile_image_url);
  return {
    key: { id, host: accountHost(context) },
    handle,
    displayName: handle,
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

async function fetchProfileData(
  idOrHandle: string,
  context: PluginInvocationContextV1,
  cookies: CookiePair[],
): Promise<ProfileV1> {
  let userInfo: Record<string, unknown> | null = null;
  try {
    const res = await requestJson(
      context.origin + "/api/container/getIndex?type=uid&value=" + encodeURIComponent(idOrHandle),
      context,
      cookies,
      {},
      true,
      true,
    );
    if (res && isRecord(res.data) && isRecord(res.data.userInfo)) {
      userInfo = res.data.userInfo;
    }
  } catch {
    // fallback
  }

  if (!userInfo) {
    try {
      const res = await requestJson(
        context.origin +
          "/api/container/getIndex?type=uid&value=" +
          encodeURIComponent(idOrHandle) +
          "&containerid=100505" +
          encodeURIComponent(idOrHandle),
        context,
        cookies,
        {},
        true,
        true,
      );
      if (res && isRecord(res.data) && isRecord(res.data.userInfo)) {
        userInfo = res.data.userInfo;
      }
    } catch {
      // fallback
    }
  }

  if (userInfo) {
    const id = String(userInfo.id || idOrHandle);
    const screenName = String(userInfo.screen_name || id);
    const avatarUrl = safeWeiboMediaUrl(userInfo.avatar_hd ?? userInfo.profile_image_url);
    const description =
      typeof userInfo.description === "string" && userInfo.description.trim()
        ? { format: "plain" as const, value: userInfo.description.trim() }
        : undefined;

    return {
      key: { id, host: accountHost(context) },
      handle: screenName,
      displayName: screenName,
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(description ? { description } : {}),
      ...(typeof userInfo.followers_count === "number" ? { followersCount: userInfo.followers_count } : {}),
      ...(typeof userInfo.follow_count === "number" ? { followingCount: userInfo.follow_count } : {}),
      ...(typeof userInfo.statuses_count === "number" ? { postsCount: userInfo.statuses_count } : {}),
    };
  }

  return {
    key: { id: idOrHandle, host: accountHost(context) },
    handle: idOrHandle,
    displayName: idOrHandle,
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
