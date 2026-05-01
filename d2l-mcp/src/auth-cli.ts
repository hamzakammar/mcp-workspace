#!/usr/bin/env node
import "dotenv/config";
/**
 * CLI tool to manually trigger authentication.
 * Run this first to log in and save session.
 * Usage: npm run auth
 */
import { getToken, getTokenExpiry } from "./auth.js";

async function main() {
  // If D2L_TOKEN is provided, skip browser auth
  const d2lToken = process.env.D2L_TOKEN;
  console.log(`[AUTH-CLI] D2L_TOKEN check: ${d2lToken ? 'FOUND (length: ' + d2lToken.length + ')' : 'NOT FOUND'}`);
  if (d2lToken) {
    console.log("D2L_TOKEN found in environment - skipping browser authentication");
    console.log("Token will be used directly from environment variable");
    return;
  }

  const hasCredentials = process.env.D2L_USERNAME && process.env.D2L_PASSWORD;

  console.log("Starting D2L authentication...");

  if (hasCredentials) {
    console.log(
      "Using credentials from D2L_USERNAME and D2L_PASSWORD environment variables."
    );
    console.log("Automated login will be attempted...");
  } else {
    console.log("No credentials found in environment variables.");
    console.log("A browser window will open. Please log in to Brightspace.");
    console.log("");
    console.log(
      "Tip: Set D2L_USERNAME and D2L_PASSWORD to enable automated login."
    );
  }
  console.log("");

  try {
    const token = await getToken();
    const expiry = new Date(getTokenExpiry());

    console.log("");
    console.log("Authentication successful!");
    console.log(`Token expires at: ${expiry.toLocaleString()}`);
    console.log("");
    console.log(
      "Your session has been saved. The MCP server will use it automatically."
    );
    console.log("Token (first 50 chars):", token.substring(0, 50) + "...");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // REAUTH_REQUIRED means Duo MFA is needed — exit cleanly so the server still
    // starts and PM2 doesn't restart infinitely (which would spam Duo pushes).
    if (msg === 'REAUTH_REQUIRED' || msg.includes('REAUTH_REQUIRED')) {
      console.error("[AUTH-CLI] Re-authentication required (Duo MFA needed). Server will start without cached token.");
      console.error("[AUTH-CLI] Use the VNC login flow or provide D2L_TOKEN to authenticate.");
      process.exit(0);
    }
    console.error("Authentication failed:", error);
    if (hasCredentials) {
      console.error("");
      console.error("If automated login failed, you may need to:");
      console.error("1. Check that D2L_USERNAME and D2L_PASSWORD are correct");
      console.error(
        "2. Try running without credentials to use browser-based login"
      );
    } else {
      console.error("");
      console.error("D2L authentication is required. Please set:");
      console.error("  - D2L_USERNAME");
      console.error("  - D2L_PASSWORD");
      console.error("  - D2L_HOST (optional, defaults to learn.ul.ie)");
    }
    process.exit(1);
  }
}

main();
