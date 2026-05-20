const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME_EXECUTABLE_PATH =
  process.env.CHROME_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 45000;
const PROFILE_READY_TIMEOUT_MS = 30000;
const MAX_SCROLL_ATTEMPTS = 120;

function formatProfileUrl(username) {
  return `https://www.tiktok.com/@${username.replace(/^@+/, '')}`;
}

function parseCookieString(cookieString) {
  if (!cookieString) {
    return [];
  }

  return cookieString
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) {
        return null;
      }

      return {
        name: part.slice(0, separatorIndex).trim(),
        value: part.slice(separatorIndex + 1).trim(),
        domain: '.tiktok.com',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      };
    })
    .filter(Boolean);
}

async function addStealthScript(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });

    window.chrome = window.chrome || { runtime: {} };
  });
}

function normalizeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/,/g, '');
  if (!normalized) {
    return null;
  }

  const suffix = normalized.slice(-1).toUpperCase();
  const multipliers = { K: 1e3, M: 1e6, B: 1e9 };
  if (multipliers[suffix]) {
    const numeric = Number.parseFloat(normalized.slice(0, -1));
    return Number.isFinite(numeric) ? Math.round(numeric * multipliers[suffix]) : null;
  }

  const numeric = Number.parseInt(normalized, 10);
  return Number.isFinite(numeric) ? numeric : null;
}

async function launchBrowser() {
  const headless = process.env.TIKTOK_HEADLESS === '1';
  const userDataDir = path.join(os.tmpdir(), `ttdownload-${Date.now()}`);

  return chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME_EXECUTABLE_PATH,
    headless,
    viewport: { width: 1440, height: 1200 },
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezoneId: 'Asia/Jakarta',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

async function waitForProfileReady(page) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < PROFILE_READY_TIMEOUT_MS) {
    const state = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const hasChallenge = /please wait/i.test(bodyText) || /waf/i.test(bodyText);
      const hasUniversal = Boolean(
        document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent?.trim()
      );
      const hasSigi = Boolean(document.querySelector('#SIGI_STATE')?.textContent?.trim());
      const videoAnchors = document.querySelectorAll('a[href*="/video/"]').length;

      return {
        hasChallenge,
        hasUniversal,
        hasSigi,
        videoAnchors,
      };
    });

    if (!state.hasChallenge && (state.hasUniversal || state.hasSigi || state.videoAnchors > 0)) {
      return;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(
    'Profile page did not become ready in the browser. If TikTok shows a challenge, complete it and retry.'
  );
}

async function extractProfileOverview(page, requestedUsername) {
  const overview = await page.evaluate((fallbackUsername) => {
    function tryParseJson(selector) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (!text) {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch (error) {
        return null;
      }
    }

    function readUniversalData() {
      const parsed = tryParseJson('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      const userInfo =
        parsed?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo ||
        parsed?.__DEFAULT_SCOPE__?.webapp?.['user-detail']?.userInfo;

      if (!userInfo?.user) {
        return null;
      }

      return {
        username: userInfo.user.uniqueId || fallbackUsername,
        nickname: userInfo.user.nickname || '',
        followerCount:
          userInfo.statsV2?.followerCount ??
          userInfo.stats?.followerCount ??
          null,
        totalVideos:
          userInfo.statsV2?.videoCount ??
          userInfo.stats?.videoCount ??
          null,
      };
    }

    function readSigiState() {
      const parsed = tryParseJson('#SIGI_STATE');
      const userModule = parsed?.UserModule;
      if (!userModule?.users) {
        return null;
      }

      const userKey = Object.keys(userModule.users)[0];
      const user = userModule.users[userKey];
      const stats = userModule.stats?.[userKey];

      if (!user) {
        return null;
      }

      return {
        username: user.uniqueId || fallbackUsername,
        nickname: user.nickname || '',
        followerCount: stats?.followerCount ?? null,
        totalVideos: stats?.videoCount ?? null,
      };
    }

    function readDomFallback() {
      const titleText = document.querySelector('title')?.textContent || '';
      const headerText =
        document.querySelector('h1')?.textContent ||
        document.querySelector('[data-e2e="user-title"]')?.textContent ||
        '';
      const statTexts = Array.from(document.querySelectorAll('strong, h3, span'))
        .map((node) => node.textContent?.trim() || '')
        .filter(Boolean);

      return {
        username:
          headerText.replace(/^@/, '').trim() ||
          titleText.split('|')[0].replace(/^@/, '').trim() ||
          fallbackUsername,
        nickname: '',
        followerCount: null,
        totalVideos: null,
        statTexts,
      };
    }

    return readUniversalData() || readSigiState() || readDomFallback();
  }, requestedUsername);

  const totalVideos = normalizeNumber(overview.totalVideos);
  const followerCount = normalizeNumber(overview.followerCount);

  return {
    username: overview.username || requestedUsername,
    nickname: overview.nickname || '',
    followerCount,
    totalVideos,
    profileUrl: page.url(),
  };
}

async function collectVideoUrls(page, targetCount) {
  const expectedUsername = await page.evaluate(() => {
    const text = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent?.trim();
    if (!text) {
      return null;
    }

    try {
      const parsed = JSON.parse(text);
      return (
        parsed?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user?.uniqueId ||
        null
      );
    } catch (error) {
      return null;
    }
  });

  const collected = new Set();
  let stagnantIterations = 0;
  let previousSize = 0;

  for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
    const urls = await page.evaluate((targetUsername) => {
      return Array.from(document.querySelectorAll('a[href*="/video/"]'))
        .map((anchor) => anchor.href.split('?')[0])
        .filter(Boolean)
        .filter((href) => {
          if (!targetUsername) {
            return true;
          }

          const match = href.match(/tiktok\.com\/@([^/]+)\/video\//i);
          return match && match[1] && match[1].toLowerCase() === targetUsername.toLowerCase();
        });
    }, expectedUsername);

    for (const url of urls) {
      collected.add(url);
    }

    if (collected.size >= targetCount) {
      return Array.from(collected).slice(0, targetCount);
    }

    if (collected.size === previousSize) {
      stagnantIterations += 1;
    } else {
      previousSize = collected.size;
      stagnantIterations = 0;
    }

    if (stagnantIterations >= 8) {
      break;
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1200);
  }

  return Array.from(collected).slice(0, targetCount);
}

async function openProfileSession(username, cookieString) {
  const context = await launchBrowser();
  context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  await addStealthScript(context);

  if (cookieString) {
    const cookies = parseCookieString(cookieString);
    if (cookies.length) {
      await context.addCookies(cookies);
    }
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(formatProfileUrl(username), { waitUntil: 'domcontentloaded' });
  await waitForProfileReady(page);

  const profile = await extractProfileOverview(page, username);
  return { context, page, profile };
}

async function fetchVideoUrlsForCount(session, count) {
  const urls = await collectVideoUrls(session.page, count);
  return urls.map((url) => ({
    id: url.split('/video/')[1]?.split('?')[0] || '',
    url,
  }));
}

async function closeProfileSession(session) {
  if (!session?.context) {
    return;
  }

  await session.context.close();
}

module.exports = {
  closeProfileSession,
  fetchVideoUrlsForCount,
  openProfileSession,
};
