#!/usr/bin/env node
/*
 * TikTok Profile Video Downloader
 *
 * Usage:
 *   node tiktokdownload.js <username|profile_url>
 *
 * Examples:
 *   node tiktokdownload.js @someuser
 *   node tiktokdownload.js https://www.tiktok.com/@someuser
 *   TIKTOK_COOKIE="your_cookie" node tiktokdownload.js @someuser
 *   TIKTOK_COOKIE_FILE="./tiktok-cookie.txt" node tiktokdownload.js @someuser
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

let Tiktok;
try {
  Tiktok = require('@tobyg74/tiktok-api-dl');
} catch (error) {
  console.error('Error: @tobyg74/tiktok-api-dl is not installed.');
  console.error('Please run "npm install @tobyg74/tiktok-api-dl" and try again.');
  process.exit(1);
}

const {
  closeProfileSession,
  fetchVideoUrlsForCount,
  openProfileSession,
} = require('./tiktok-browser-client');

async function downloadFile(fileUrl, outputPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(fileUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to download ${fileUrl} (status: ${response.status})`);
    }

    if (!response.body) {
      throw new Error('Download response did not include a body.');
    }

    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(outputPath));
  } catch (error) {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    if (error.name === 'AbortError') {
      throw new Error('Download timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractUsername(input) {
  let candidate = input.trim();
  candidate = candidate.replace(/\?.*$/, '').replace(/\/$/, '');

  const atIndex = candidate.lastIndexOf('@');
  if (atIndex !== -1) {
    candidate = candidate.substring(atIndex + 1);
  }

  const slashIndex = candidate.indexOf('/');
  if (slashIndex !== -1) {
    candidate = candidate.substring(0, slashIndex);
  }

  return candidate.replace(/^@+/, '');
}

function formatCount(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  return new Intl.NumberFormat('en-US').format(value);
}

function getCookieValue() {
  const envCookie = (process.env.TIKTOK_COOKIE || '').trim();
  if (envCookie) {
    return envCookie;
  }

  const cookieFilePath = (process.env.TIKTOK_COOKIE_FILE || '').trim();
  if (!cookieFilePath) {
    return '';
  }

  const resolvedPath = path.resolve(cookieFilePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Cookie file not found: ${resolvedPath}`);
  }

  const fileContents = fs.readFileSync(resolvedPath, 'utf8').trim();
  if (!fileContents) {
    throw new Error(`Cookie file is empty: ${resolvedPath}`);
  }

  return fileContents.replace(/^cookie:\s*/i, '').trim();
}

function printProfileSummary(profile, totalVideoPosts, usingCookie) {
  console.log('');
  console.log('Profile summary');
  console.log(`Username: @${profile.username}`);
  console.log(`Nickname: ${profile.nickname || '-'}`);
  console.log(`Follower count: ${formatCount(profile.followerCount)}`);
  console.log(`Eligible video posts: ${formatCount(totalVideoPosts)}`);
  console.log(`Profile URL: ${profile.profileUrl}`);
  console.log(`Browser session: ${usingCookie ? 'with cookie' : 'without cookie'}`);
  console.log('');
}

async function promptDownloadCount(totalVideos) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (
        await rl.question(
          `Type "all" to download all ${totalVideos} video(s), or enter a number from 1 to ${totalVideos}: `
        )
      )
        .trim()
        .toLowerCase();

      if (answer === 'all') {
        return totalVideos;
      }

      const parsed = Number.parseInt(answer, 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= totalVideos) {
        return parsed;
      }

      console.log(`Invalid input. Enter "all" or a number between 1 and ${totalVideos}.`);
    }
  } finally {
    rl.close();
  }
}

async function run() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node tiktokdownload.js <username|profile_url>');
    process.exit(1);
  }

  const requestedUsername = extractUsername(input);
  if (!requestedUsername) {
    console.error('Error: Could not determine TikTok username from input:', input);
    process.exit(1);
  }

  let cookie = '';
  try {
    cookie = getCookieValue();
  } catch (error) {
    console.error(`Error loading cookie: ${error.message}`);
    return;
  }

  console.log(`Opening TikTok profile in browser for user: ${requestedUsername}`);

  let session;
  try {
    session = await openProfileSession(requestedUsername, cookie || undefined);
  } catch (error) {
    console.error(`Error fetching profile: ${error.message}`);
    return;
  }

  const { profile } = session;
  let eligibleVideoCount = profile.totalVideos;
  let prefetchedVideos = [];

  if (!eligibleVideoCount || eligibleVideoCount < 1) {
    console.log('Total video count was not available from profile metadata. Collecting video links from the profile page...');
    try {
      prefetchedVideos = await fetchVideoUrlsForCount(session, 9999);
      eligibleVideoCount = prefetchedVideos.length;
    } catch (error) {
      await closeProfileSession(session);
      console.error(`Error collecting videos from profile: ${error.message}`);
      return;
    }
  }

  printProfileSummary(profile, eligibleVideoCount, Boolean(cookie));

  if (!eligibleVideoCount) {
    await closeProfileSession(session);
    console.log('No video posts were found for this profile.');
    return;
  }

  const selectedCount = await promptDownloadCount(eligibleVideoCount);

  let selectedPosts = prefetchedVideos.slice(0, selectedCount);
  if (selectedPosts.length < selectedCount) {
    try {
      selectedPosts = await fetchVideoUrlsForCount(session, selectedCount);
    } catch (error) {
      await closeProfileSession(session);
      console.error(`Error collecting selected video links: ${error.message}`);
      return;
    }
  }

  await closeProfileSession(session);

  if (!selectedPosts.length) {
    console.log('No video links could be collected from the profile.');
    return;
  }

  if (selectedPosts.length < selectedCount) {
    console.warn(
      `Only ${selectedPosts.length} video link(s) were collected from the page, less than the requested ${selectedCount}.`
    );
  }

  const outDir = path.join(process.cwd(), profile.username);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('');
  console.log(`Output folder: ${outDir}`);
  console.log(`Starting HD download for ${selectedPosts.length} video(s)...`);

  let downloadedCount = 0;
  let skippedHdUnavailableCount = 0;
  let failedCount = 0;

  for (const [index, post] of selectedPosts.entries()) {
    console.log(`[${index + 1}/${selectedPosts.length}] Processing ${post.id}...`);

    try {
      const dlResponse = await Tiktok.Downloader(post.url, { version: 'v3' });
      if (!dlResponse || dlResponse.status !== 'success' || !dlResponse.result) {
        failedCount += 1;
        console.warn(`Failed to retrieve download metadata for ${post.id}.`);
        continue;
      }

      if (!dlResponse.result.videoHD) {
        skippedHdUnavailableCount += 1;
        console.log(`Skipped ${post.id}: HD unavailable.`);
        continue;
      }

      const filePath = path.join(outDir, `${post.id}.mp4`);
      await downloadFile(dlResponse.result.videoHD, filePath);
      downloadedCount += 1;
      console.log(`Downloaded HD: ${filePath}`);
    } catch (error) {
      failedCount += 1;
      console.warn(`Failed ${post.id}: ${error.message}`);
    }
  }

  console.log('');
  console.log('Download summary');
  console.log(`Selected videos: ${selectedPosts.length}`);
  console.log(`Downloaded HD: ${downloadedCount}`);
  console.log(`Skipped (HD unavailable): ${skippedHdUnavailableCount}`);
  console.log(`Failed: ${failedCount}`);
}

run().catch((error) => {
  console.error('Unexpected error:', error.message);
});
