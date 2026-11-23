// Friends on the home page (signed in): who's online or in a game, with Join when webblox can follow
// them into their server. Friend requests and adding friends live in a sheet.

import { acceptFriendRequest, declineFriendRequest, friendRequestCount, friendRequests, friendsList, headshots, presences, sendFriendRequest, userByName } from "../lib/social.js";

const ORDER = { game: 0, online: 1, studio: 2, invisible: 3, offline: 4 };
const REFRESH_MS = 60000;

function statusText(p) {
	if (!p || p.kind === "offline" || p.kind === "invisible") return "Offline";
	if (p.kind === "game") return p.place ? `Playing ${p.place}` : "In a game";
	if (p.kind === "studio") return "In Roblox Studio";
	return "Online";
}

export function initFriends(ui) {
	const { $, getNet, setImage, launch, connectionHint } = ui;
	let user = null;
	let timer = null;
	let run = 0;
	let requestsCursor = null;

	const errorText = (err) => (err.status ? err.message : connectionHint(err));

	function avatar(url, kind) {
		const pic = document.createElement("div");
		pic.className = "friend-pic";
		const img = document.createElement("img");
		img.alt = "";
		img.loading = "lazy";
		if (url) setImage(img, url);
		pic.append(img);
		if (kind) {
			const dot = document.createElement("span");
			dot.className = "presence-dot";
			dot.dataset.kind = kind;
			pic.append(dot);
		}
		return pic;
	}

	function tile(friend, presence, picture) {
		const el = document.createElement("div");
		el.className = "friend";
		el.dataset.kind = presence?.kind || "offline";
		const name = document.createElement("div");
		name.className = "friend-name";
		name.textContent = friend.displayName;
		name.title = `@${friend.name}`;
		const status = document.createElement("div");
		status.className = "friend-status";
		status.textContent = statusText(presence);
		status.title = status.textContent;
		el.append(avatar(picture, presence?.kind || "offline"), name, status);
		if (presence?.joinable) {
			const join = document.createElement("button");
			join.type = "button";
			join.className = "btn small primary";
			join.textContent = "Join";
			join.onclick = () => launch({ followUserId: friend.id }, presence.place ? { placeId: presence.placeId, universeId: presence.universeId, name: presence.place } : undefined);
			el.append(join);
		}
		return el;
	}

	async function refresh() {
		if (!user) return;
		const mine = ++run;
		const row = $("friends");
		try {
			const net = await getNet();
			const friends = await friendsList(net, user.id);
			if (mine !== run) return;
			$("friends-count").textContent = friends.length ? String(friends.length) : "";
			if (!friends.length) {
				row.replaceChildren(ui.emptyState("No friends yet. Add someone by their username."));
				return;
			}
			const ids = friends.map((f) => f.id);
			const [pres, pics] = await Promise.all([presences(net, ids).catch(() => new Map()), headshots(net, ids).catch(() => new Map())]);
			if (mine !== run) return;
			friends.sort((a, b) => (ORDER[pres.get(a.id)?.kind] ?? 4) - (ORDER[pres.get(b.id)?.kind] ?? 4) || a.displayName.localeCompare(b.displayName));
			row.replaceChildren(...friends.map((f) => tile(f, pres.get(f.id), pics.get(f.id))));
		} catch (err) {
			if (mine === run) row.replaceChildren(ui.emptyState(`Friends didn't load. ${errorText(err)}`));
		}
		updateBadge();
	}

	async function updateBadge() {
		try {
			const count = await friendRequestCount(await getNet());
			const badge = $("friend-requests-badge");
			badge.textContent = count > 99 ? "99+" : String(count);
			badge.hidden = !count;
		} catch {
			// the count is a nicety
		}
	}

	function show(u) {
		if (user?.id === u.id && timer) return;
		user = u;
		$("friends-section").hidden = false;
		$("friends").replaceChildren(ui.emptyState("Loading friends…"));
		clearInterval(timer);
		timer = setInterval(() => document.visibilityState === "visible" && refresh(), REFRESH_MS);
		refresh();
	}

	function hide() {
		user = null;
		run++;
		clearInterval(timer);
		timer = null;
		$("friends-section").hidden = true;
	}

	// ---- requests and adding ---------------------------------------------------------------

	function requestItem(r, picture) {
		const li = document.createElement("li");
		li.append(avatar(picture));
		const who = document.createElement("div");
		who.className = "person";
		const dn = document.createElement("strong");
		dn.textContent = r.displayName;
		const un = document.createElement("span");
		un.className = "small muted";
		un.textContent = `@${r.name}`;
		who.append(dn, un);
		const actions = document.createElement("div");
		actions.className = "row";
		const decide = (fn, done) => async () => {
			for (const b of actions.querySelectorAll("button")) b.disabled = true;
			try {
				await fn(await getNet(), r.id);
				actions.replaceChildren(Object.assign(document.createElement("span"), { className: "small muted", textContent: done }));
				refresh();
			} catch (err) {
				for (const b of actions.querySelectorAll("button")) b.disabled = false;
				$("add-friend-status").textContent = errorText(err);
				$("add-friend-status").dataset.kind = "error";
			}
		};
		const accept = Object.assign(document.createElement("button"), { type: "button", className: "btn small primary", textContent: "Accept" });
		accept.onclick = decide(acceptFriendRequest, "Friends now");
		const decline = Object.assign(document.createElement("button"), { type: "button", className: "btn small", textContent: "Decline" });
		decline.onclick = decide(declineFriendRequest, "Declined");
		actions.append(accept, decline);
		li.append(who, actions);
		return li;
	}

	async function loadRequests(more = false) {
		const list = $("requests-list");
		if (!more) {
			requestsCursor = null;
			list.replaceChildren(ui.emptyState("Loading requests…"));
		}
		try {
			const net = await getNet();
			const { requests, nextCursor } = await friendRequests(net, requestsCursor);
			requestsCursor = nextCursor;
			const pics = await headshots(net, requests.map((r) => r.id)).catch(() => new Map());
			const items = requests.map((r) => requestItem(r, pics.get(r.id)));
			if (more) list.append(...items);
			else list.replaceChildren(...(items.length ? items : [ui.emptyState("No friend requests.")]));
			$("requests-more").hidden = !nextCursor;
		} catch (err) {
			list.replaceChildren(ui.emptyState(errorText(err)));
		}
	}

	function openRequests() {
		$("add-friend-status").textContent = "";
		$("friends-dialog").showModal();
		loadRequests();
	}
	$("friend-requests-btn").onclick = openRequests;
	$("add-friend-btn").onclick = () => {
		openRequests();
		$("add-friend-name").focus();
	};
	$("requests-more").onclick = () => loadRequests(true);
	$("friends-dialog").addEventListener("close", updateBadge);

	$("add-friend-form").addEventListener("submit", async (e) => {
		e.preventDefault();
		const status = $("add-friend-status");
		const name = $("add-friend-name").value.trim();
		if (!name) return;
		const button = e.submitter || $("add-friend-form").querySelector("button");
		button.disabled = true;
		status.dataset.kind = "info";
		status.textContent = "Looking them up…";
		try {
			const net = await getNet();
			const target = await userByName(net, name);
			if (!target) throw Object.assign(new Error(`There's no Roblox user called ${name}.`), { userFacing: true });
			if (target.id === user?.id) throw Object.assign(new Error("That's you."), { userFacing: true });
			status.textContent = `Sending a request to ${target.displayName}…`;
			await sendFriendRequest(net, target.id, { progress: (t) => (status.textContent = t) });
			status.textContent = `Friend request sent to ${target.displayName} (@${target.name}).`;
			$("add-friend-name").value = "";
		} catch (err) {
			status.dataset.kind = "error";
			status.textContent = err.captcha
				? "Roblox wants a CAPTCHA before this friend request, and its CAPTCHA only works on roblox.com. Send it from the Roblox app instead."
				: err.userFacing || err.status
					? err.message
					: connectionHint(err);
		} finally {
			button.disabled = false;
		}
	});

	return { show, hide, refresh };
}
