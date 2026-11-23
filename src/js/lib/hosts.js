// Hosts whose traffic webblox carries itself (over Wisp) instead of leaving it to the browser.
export const isRobloxHost = (host) => /(^|\.)roblox\.com$/i.test(host);
export const isRbxCdnHost = (host) => /(^|\.)rbxcdn\.com$/i.test(host);
export const isProxiedHost = (host) => isRobloxHost(host) || isRbxCdnHost(host);
