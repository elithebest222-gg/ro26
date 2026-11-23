// Service worker for the app root. It only routes the sign-in browser's proxied frames
// (Scramjet, under ~/sj/) to their controller; the player has its own worker in player/.
importScripts("controller/controller.sw.js");

self.addEventListener("fetch", (event) => {
	if ($scramjetController.shouldRoute(event)) event.respondWith($scramjetController.route(event));
});
