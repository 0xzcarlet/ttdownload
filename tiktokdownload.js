#!/usr/bin/env node
/*
 * TikTok Profile Video Downloader
 *
 * Usage:
 *   Single user:  node tiktokdownload.js <username|profile_url>
 *   Multi-user:   node tiktokdownload.js
 *                 (reads usernames from username.txt)
 *
 * Examples:
 *   node tiktokdownload.js @someuser
 *   node tiktokdownload.js https://www.tiktok.com/@someuser
 *   TIKTOK_COOKIE="your_cookie" node tiktokdownload.js @someuser
 *   TIKTOK_COOKIE_FILE="./tiktok-cookie.txt" node tiktokdownload.js @someuser
 *
 * Multi-user example:
 *   1. Create username.txt with one username per line
 *   2. Run: TIKTOK_COOKIE_FILE="./cokie.txt" node tiktokdownload.js
 *   3. Enter how many videos to download per account
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

function loadUsernamesFromFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return [];
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => extractUsername(line));
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

async function promptVideoCount() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (
        await rl.question(
          'How many latest videos to download per account? Enter a number (e.g. 10): '
        )
      )
        .trim()
        .toLowerCase();

      if (answer === 'all') {
        return 'all';
      }

      const parsed = Number.parseInt(answer, 10);
      if (Number.isInteger(parsed) && parsed >= 1) {
        return parsed;
      }

      console.log('Invalid input. Enter a positive number or "all".');
    }
  } finally {
    rl.close();
  }
}

async function downloadSingleUser(requestedUsername, videoCount, cookie) {
  console.log('');
  console.log(`${'='.repeat(60)}`);
  console.log(`Processing user: @${requestedUsername}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Opening TikTok profile in browser for user: ${requestedUsername}`);

  let session;
  try {
    session = await openProfileSession(requestedUsername, cookie || undefined);
  } catch (error) {
    console.error(`Error fetching profile for @${requestedUsername}: ${error.message}`);
    return { username: requestedUsername, downloaded: 0, skipped: 0, failed: 0, error: error.message };
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
      return { username: requestedUsername, downloaded: 0, skipped: 0, failed: 0, error: error.message };
    }
  }

  printProfileSummary(profile, eligibleVideoCount, Boolean(cookie));

  if (!eligibleVideoCount) {
    await closeProfileSession(session);
    console.log('No video posts were found for this profile.');
    return { username: requestedUsername, downloaded: 0, skipped: 0, failed: 0, error: null };
  }

  // Determine how many videos to actually download
  let selectedCount;
  if (videoCount === 'all') {
    selectedCount = eligibleVideoCount;
  } else if (typeof videoCount === 'number') {
    selectedCount = Math.min(videoCount, eligibleVideoCount);
  } else {
    // Single-user mode: prompt user interactively
    selectedCount = await promptDownloadCount(eligibleVideoCount);
  }

  let selectedPosts = prefetchedVideos.slice(0, selectedCount);
  if (selectedPosts.length < selectedCount) {
    try {
      selectedPosts = await fetchVideoUrlsForCount(session, selectedCount);
    } catch (error) {
      await closeProfileSession(session);
      console.error(`Error collecting selected video links: ${error.message}`);
      return { username: requestedUsername, downloaded: 0, skipped: 0, failed: 0, error: error.message };
    }
  }

  await closeProfileSession(session);

  if (!selectedPosts.length) {
    console.log('No video links could be collected from the profile.');
    return { username: requestedUsername, downloaded: 0, skipped: 0, failed: 0, error: null };
  }

  if (selectedPosts.length < selectedCount) {
    console.warn(
      `Only ${selectedPosts.length} video link(s) were collected from the page, less than the requested ${selectedCount}.`
    );
  }

  // OUTPUT DIRECTORY: ./video/username/
  const outDir = path.join(process.cwd(), 'video', profile.username);
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
  console.log(`Download summary for @${profile.username}`);
  console.log(`Selected videos: ${selectedPosts.length}`);
  console.log(`Downloaded HD: ${downloadedCount}`);
  console.log(`Skipped (HD unavailable): ${skippedHdUnavailableCount}`);
  console.log(`Failed: ${failedCount}`);

  return {
    username: profile.username,
    downloaded: downloadedCount,
    skipped: skippedHdUnavailableCount,
    failed: failedCount,
    error: null,
  };
}

async function run() {
  const input = process.argv[2];

  let cookie = '';
  try {
    cookie = getCookieValue();
  } catch (error) {
    console.error(`Error loading cookie: ${error.message}`);
    return;
  }

  // MODE 1: Single user mode (backward compatible)
  if (input) {
    const requestedUsername = extractUsername(input);
    if (!requestedUsername) {
      console.error('Error: Could not determine TikTok username from input:', input);
      process.exit(1);
    }

    // Single user mode: videoCount = null → will prompt interactively
    await downloadSingleUser(requestedUsername, null, cookie);
    return;
  }

  // MODE 2: Multi-account mode (read from username.txt)
  const usernameFile = path.join(process.cwd(), 'username.txt');
  const usernames = loadUsernamesFromFile(usernameFile);

  if (!usernames.length) {
    console.error('Usage:');
    console.error('  Single user:  node tiktokdownload.js <username|profile_url>');
    console.error('  Multi-user:   node tiktokdownload.js');
    console.error('');
    console.error('For multi-user mode, create a "username.txt" file with one username per line.');
    process.exit(1);
  }

  console.log(`Found ${usernames.length} username(s) in username.txt:`);
  for (const [i, u] of usernames.entries()) {
    console.log(`  ${i + 1}. @${u}`);
  }
  console.log('');

  const videoCount = await promptVideoCount();

  console.log('');
  console.log(`Will download ${videoCount === 'all' ? 'ALL' : videoCount} latest video(s) per account.`);
  console.log(`Starting batch download for ${usernames.length} account(s)...`);

  const results = [];
  for (const username of usernames) {
    const result = await downloadSingleUser(username, videoCount, cookie);
    results.push(result);
  }

  // Print batch summary
  console.log('');
  console.log('='.repeat(60));
  console.log('BATCH DOWNLOAD COMPLETE');
  console.log('='.repeat(60));
  console.log('');

  for (const r of results) {
    const status = r.error ? `ERROR: ${r.error}` : `OK (${r.downloaded} downloaded, ${r.skipped} skipped, ${r.failed} failed)`;
    console.log(`  @${r.username}: ${status}`);
  }

  const totalDownloaded = results.reduce((sum, r) => sum + r.downloaded, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const totalErrors = results.filter((r) => r.error).length;

  console.log('');
  console.log(`Total: ${totalDownloaded} downloaded, ${totalSkipped} skipped, ${totalFailed} failed, ${totalErrors} error(s)`);
}

run().catch((error) => {
  console.error('Unexpected error:', error.message);
});
