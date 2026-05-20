# Cookie Setup Guide

This guide explains how to export a TikTok cookie with the **Cookie-Editor** browser extension and use it with this script.

## Why a Cookie Is Needed

This project uses browser automation to open TikTok profiles and collect video links. In many cases, TikTok blocks anonymous requests or shows additional checks, so using your logged-in cookie helps the script access the target profile more reliably.

## What You Need

- Google Chrome
- A TikTok account that is already logged in
- The **Cookie-Editor** extension installed in Chrome

## Install Cookie-Editor

1. Open Chrome.
2. Go to the Chrome Web Store.
3. Search for `Cookie-Editor`.
4. Install the extension.
5. Pin it to the Chrome toolbar so it is easy to access.

## Export the TikTok Cookie

1. Open `https://www.tiktok.com` in Chrome.
2. Make sure you are logged in to your TikTok account.
3. Click the **Cookie-Editor** extension icon.
4. Confirm that the current domain is TikTok.
5. Choose the export option named **Header String**.
6. Copy the exported cookie string.

The value you copy should look similar to this:

```txt
sessionid=xxx; sid_guard=yyy; tt_csrf_token=zzz
```

Important notes:

- Use **Header String**, not JSON or Netscape format.
- If the exported value starts with `Cookie:`, you can keep it or remove it.
- This script will automatically clean the `Cookie:` prefix if it exists.

## Save the Cookie for This Script

1. Inside the project folder, create a file named `cokie.txt`.
2. Paste the exported cookie string into that file.
3. Save the file.

Example:

```txt
sessionid=xxx; sid_guard=yyy; tt_csrf_token=zzz
```

## Run the Script with the Cookie File

From the project folder, run:

```bash
TIKTOK_COOKIE_FILE="./cokie.txt" node tiktokdownload.js @exampleuser
```

You can also use a full profile URL:

```bash
TIKTOK_COOKIE_FILE="./cokie.txt" node tiktokdownload.js https://www.tiktok.com/@exampleuser
```

## Alternative: Use an Environment Variable

If you do not want to store the cookie in a file, you can pass it directly:

```bash
TIKTOK_COOKIE='sessionid=xxx; sid_guard=yyy; tt_csrf_token=zzz' node tiktokdownload.js @exampleuser
```

Using a file is usually easier for repeated testing.

## Troubleshooting

### The script says the cookie file cannot be found

Make sure:

- the file is really named `cokie.txt`
- the file is inside the project folder
- you are running the command from the project folder

### The script still cannot open the profile

Try these checks:

- confirm the TikTok account is still logged in inside Chrome
- export the cookie again from Cookie-Editor
- make sure the cookie string is complete and not cut off
- retry with the browser visible instead of headless mode

## Security Notes

- Treat your TikTok cookie like a password.
- Do not commit `cokie.txt` to a public repository.
- Do not share the cookie string with other people.
- If you think the cookie has been exposed, log out of TikTok and log in again to refresh the session.
