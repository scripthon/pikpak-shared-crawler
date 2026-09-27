// pikpak-shared-crawler/src/client.ts
import { PikPakClient } from "pikpak-sdk";

export interface CrawlClientOptions {
  accessToken?: string;
  refreshToken?: string;
  deviceId?: string;
}

/**
 * Creates a PikPak client suitable for crawling public share links.
 *
 * Public shares are browsed anonymously, so no credentials are required. Pass
 * explicit tokens to act as an authenticated account.
 */
export function createCrawlClient(options: CrawlClientOptions = {}): PikPakClient {
  return new PikPakClient({
    accessToken: options.accessToken,
    refreshToken: options.refreshToken,
    deviceId: options.deviceId,
  });
}
