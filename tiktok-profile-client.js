const crypto = require('crypto');

const Tiktok = require('@tobyg74/tiktok-api-dl');

const TIKTOK_URL = 'https://www.tiktok.com';
const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.35';
const AES_KEY = 'webapp1.0+202106';
const AES_IV = 'webapp1.0+202106';
const POSTS_ENDPOINT = `${TIKTOK_URL}/api/post/item_list/`;
const STATIC_MS_TOKEN =
  '7UfjxOYL5mVC8QFOKQRhmLR3pCjoxewuwxtfFIcPweqC05Q6C_qjW-5Ba6_fE5-fkZc0wkLSWaaesA4CZ0LAqRrXSL8b88jGvEjbZPwLIPnHeyQq6VifzyKf5oGCQNw_W4Xq12Q-8KCuyiKGLOw=';
const STATIC_X_BOGUS = 'DFSzswVL-XGANHVWS0OnS2XyYJUm';
const MAX_POST_PAGES = 100;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStaticPostsQuery() {
  const params = new URLSearchParams({
    aid: '1988',
    app_language: 'en',
    app_name: 'tiktok_web',
    battery_info: '1',
    browser_language: 'en-US',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'Win32',
    browser_version:
      '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.35',
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    device_id: '7002566096994190854',
    device_platform: 'web_pc',
    focus_state: 'false',
    from_page: 'user',
    history_len: '3',
    is_fullscreen: 'false',
    is_page_visible: 'true',
    os: 'windows',
    priority_region: 'RO',
    referer: 'https://exportcomments.com/',
    region: 'RO',
    root_referer: 'https://exportcomments.com/',
    screen_height: '1440',
    screen_width: '2560',
    tz_name: 'Europe/Bucharest',
    verifyFp: 'verify_lacphy8d_z2ux9idt_xdmu_4gKb_9nng_NNTTTvsFS8ao',
    webcast_language: 'en',
    msToken: STATIC_MS_TOKEN,
    'X-Bogus': STATIC_X_BOGUS,
  });

  return params.toString();
}

function buildEncryptedPostsPayload(secUid, cursor, count) {
  return new URLSearchParams({
    aid: '1988',
    cookie_enabled: 'true',
    screen_width: '0',
    screen_height: '0',
    browser_language: '',
    browser_platform: '',
    browser_name: '',
    browser_version: '',
    browser_online: '',
    timezone_name: 'Europe/London',
    secUid,
    cursor: String(cursor),
    count: String(count),
    is_encryption: '1',
  }).toString();
}

function generateXttParams(payload) {
  const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
  return Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]).toString('base64');
}

function normalizeProfileFromStalkResponse(response, fallbackUsername) {
  if (!response || response.status !== 'success' || !response.result?.user?.secUid) {
    return null;
  }

  const user = response.result.user;
  const stats = response.result.statsV2 || response.result.stats || {};

  return {
    username: user.username || fallbackUsername,
    nickname: user.nickname || '',
    secUid: user.secUid,
    followerCount: typeof stats.followerCount === 'number' ? stats.followerCount : null,
    profileUrl: `${TIKTOK_URL}/@${user.username || fallbackUsername}`,
  };
}

async function resolveProfile(username, cookie) {
  const normalizedUsername = username.replace(/^@+/, '').trim();
  const stalkResponse = await Tiktok.StalkUser(normalizedUsername);
  const stalkProfile = normalizeProfileFromStalkResponse(stalkResponse, normalizedUsername);

  if (stalkProfile) {
    return {
      profile: stalkProfile,
      usedCookieFallback: false,
      warnings: [],
    };
  }

  const stalkError = stalkResponse?.message || 'Anonymous profile lookup failed.';
  if (!cookie) {
    throw new Error(`${stalkError} Set TIKTOK_COOKIE to enable cookie fallback.`);
  }

  const searchResponse = await Tiktok.Search(normalizedUsername, {
    type: 'user',
    cookie,
  });

  if (!searchResponse || searchResponse.status !== 'success' || !Array.isArray(searchResponse.result)) {
    throw new Error(
      `Cookie fallback failed: ${searchResponse?.message || 'Unable to search TikTok user.'}`
    );
  }

  const exactMatch = searchResponse.result.find(
    (user) => user.username?.toLowerCase() === normalizedUsername.toLowerCase()
  );

  if (!exactMatch?.secUid) {
    throw new Error(
      `Cookie fallback could not find an exact username match for @${normalizedUsername}.`
    );
  }

  return {
    profile: {
      username: exactMatch.username,
      nickname: exactMatch.nickname || '',
      secUid: exactMatch.secUid,
      followerCount:
        typeof exactMatch.followerCount === 'number' ? exactMatch.followerCount : null,
      profileUrl: exactMatch.url || `${TIKTOK_URL}/@${exactMatch.username}`,
    },
    usedCookieFallback: true,
    warnings: [stalkError],
  };
}

async function requestJson(url, headers, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    if (!text) {
      throw new Error('Empty response from TikTok API.');
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Expected JSON response but received: ${text.slice(0, 200)}`);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getPostsPageConfig(page, cursor) {
  if (page === 1) {
    return { cursor: 0, count: 35 };
  }

  if (page === 2) {
    return { cursor: 0, count: 30 };
  }

  return { cursor, count: 16 };
}

function normalizePost(item, fallbackUsername) {
  const authorUsername = item?.author?.uniqueId || fallbackUsername;

  return {
    id: item?.id || item?.video?.id || '',
    createTime: Number(item?.createTime) || 0,
    desc: item?.desc || '',
    author: {
      username: authorUsername,
      nickname: item?.author?.nickname || '',
    },
    video: item?.video
      ? {
          id: item.video.id || item.id || '',
          duration: Number(item.video.duration) || 0,
          ratio: item.video.ratio || '',
          cover: item.video.cover || '',
          originCover: item.video.originCover || '',
          dynamicCover: item.video.dynamicCover || '',
          playAddr: Array.isArray(item.video.playAddr)
            ? item.video.playAddr[0]
            : item.video.playAddr || '',
          downloadAddr: Array.isArray(item.video.downloadAddr)
            ? item.video.downloadAddr[0]
            : item.video.downloadAddr || '',
          format: item.video.format || '',
          bitrate: Number(item.video.bitrate) || 0,
        }
      : null,
    url: `${TIKTOK_URL}/@${authorUsername}/video/${item?.id || item?.video?.id || ''}`,
  };
}

function getApiErrorMessage(data) {
  return (
    data?.statusMsg ||
    data?.status_msg ||
    data?.message ||
    data?.statusMessage ||
    'TikTok API returned an error.'
  );
}

async function requestPostsPage(profile, cookie, page, cursor) {
  const pageConfig = getPostsPageConfig(page, cursor);
  const xttParams = generateXttParams(
    buildEncryptedPostsPayload(profile.secUid, pageConfig.cursor, pageConfig.count)
  );

  const headers = {
    'accept': 'application/json, text/plain, */*',
    'referer': profile.profileUrl,
    'user-agent': WEB_USER_AGENT,
    'x-tt-params': xttParams,
  };

  if (cookie) {
    headers.cookie = cookie;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await requestJson(`${POSTS_ENDPOINT}?${buildStaticPostsQuery()}`, headers);
      const numericStatusCode =
        typeof data?.statusCode === 'number'
          ? data.statusCode
          : typeof data?.status_code === 'number'
            ? data.status_code
            : 0;

      if (numericStatusCode !== 0 && !Array.isArray(data?.itemList)) {
        throw new Error(getApiErrorMessage(data));
      }

      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await delay(attempt * 500);
      }
    }
  }

  throw lastError || new Error('Failed to fetch TikTok posts.');
}

async function fetchProfilePosts(profile, cookie) {
  const normalizedPosts = [];
  const seenIds = new Set();
  let page = 1;
  let cursor = 0;
  let hasMore = true;
  let emptyPageStreak = 0;

  while (hasMore && page <= MAX_POST_PAGES) {
    const data = await requestPostsPage(profile, cookie, page, cursor);
    const itemList = Array.isArray(data?.itemList) ? data.itemList : [];

    if (!itemList.length) {
      emptyPageStreak += 1;
    } else {
      emptyPageStreak = 0;
    }

    if (emptyPageStreak >= 2) {
      throw new Error('TikTok returned empty post pages repeatedly.');
    }

    for (const item of itemList) {
      const normalizedPost = normalizePost(item, profile.username);
      if (!normalizedPost.id || seenIds.has(normalizedPost.id)) {
        continue;
      }

      seenIds.add(normalizedPost.id);
      normalizedPosts.push(normalizedPost);
    }

    hasMore = Boolean(data?.hasMore);
    cursor = hasMore ? Number(data?.cursor) || 0 : 0;
    page += 1;
  }

  normalizedPosts.sort((left, right) => right.createTime - left.createTime);
  return normalizedPosts;
}

module.exports = {
  resolveProfile,
  fetchProfilePosts,
};
