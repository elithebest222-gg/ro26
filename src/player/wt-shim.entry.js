// Bundled as player/wt-shim.js. The player's service worker loads it (importScripts) at the top
// of the engine's worker threads, before WebClient.js runs, with self.__webbloxClient set to the
// page's id.
import { installWebTransportShim } from "../js/lib/wt-shim.js";

installWebTransportShim(self, { client: self.__webbloxClient || "" });
