const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { harness, tap, ROOT, clone } = require("./fixtures/canteen-host.cjs");
const tick = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

test("canteen initially shows one idle decision button with 87 candidates and no implicit request", () => {
	const h = harness();
	assert.equal(h.page.data.decisionLabel, "帮我决定");
	assert.deepEqual(h.page.data.cards, []);
	assert.equal(h.page._round.snapshot().totalCount, 87);
	assert.equal(h.requests.length, 0);
	assert.equal(h.historyWrites().length, 0);
});
test("obsolete saved budgets never reduce or price-sort the new canteen round", async () => {
	const h = harness();
	h.profile.answers.budgetCents = 1;
	h.page.syncState();
	assert.equal(h.page._round.snapshot().totalCount, 87);
	await h.draw();
	assert.ok(h.page.data.cards[0]);
	assert.equal(h.requests.length, 0);
});
test("missing confirmed taste blocks drawing and redirects to the canteen preference gate", async () => {
	const h = harness({ ready: false });
	await h.draw();
	assert.equal(h.page.data.status, "profile-required");
	assert.equal(h.page._round, null);
	assert.equal(h.requests.length, 0);
	assert.ok(
		h.calls.some(
			(call) =>
				call.name === "ensureTasteProfile" && call.value.returnTo === "canteen",
		),
	);
});
test("the new page contains no budget, category, variant or confirmation controls", () => {
	const h = harness(),
		wxml = fs.readFileSync(path.join(ROOT, "pages/canteen/index.wxml"), "utf8");
	assert.equal((wxml.match(/<button\b/g) || []).length, 1);
	assert.match(wxml, /bindtap="decide"/);
	assert.doesNotMatch(
		wxml,
		/<input|<picker|bindtap="confirm"|bindtap="selectVariant"|budget/,
	);
	assert.equal(h.page.inputBudget, undefined);
	assert.equal(h.page.confirm, undefined);
});
test("multi-price cards show complete original specifications without recording a choice", async () => {
	const h = harness();
	await h.choose("虾三鲜馄饨");
	assert.equal(h.page.data.cards[0].originalPriceText, "小份10元；大份14元");
	assert.equal(h.page.data.cards[0].priceNumber, "");
	assert.equal(h.historyWrites().length, 0);
});
test("single-size menu v2 cards never resurrect the removed small price", async () => {
	for (const name of ["福建扁食", "紫菜虾米馄饨", "荠菜馄饨"]) {
		const h = harness();
		await h.choose(name);
		assert.equal(h.page.data.cards[0].originalPriceText, "大份13元");
	}
});
test("weight-priced cards preserve rates and reference wording without a fabricated amount", async () => {
	const h = harness();
	await h.choose("麻辣香锅");
	const card = h.page.data.cards[0];
	assert.equal(card.priceKind, "weight");
	assert.equal(card.originalPriceText, "素菜1.2元/50g；荤菜2.8元/50g，均价14");
	assert.equal(card.priceNumber, "");
	assert.equal(h.historyWrites().length, 0);
});
test("rapid consecutive taps draw once while a decision is pending in both motion settings", async () => {
	for (const reducedMotion of [false, true]) {
		const h = harness({ reducedMotion });
		const first = h.page.decide(tap(h.page));
		const second = h.page.decide(tap(h.page));
		await Promise.all([first, second]);
		h.flushTimers();
		assert.equal(h.randomCalls(), 1);
		assert.equal(h.page._round.snapshot().seenCount, 1);
		assert.equal(h.page.data.busy, false);
	}
});
test("a stale card revision cannot draw a replacement for a newer card", async () => {
	const h = harness();
	await h.draw();
	const old = tap(h.page);
	await h.draw();
	const before = clone(h.page.data);
	await h.page.decide(old);
	assert.deepEqual(h.page.data, before);
	assert.equal(h.randomCalls(), 2);
});
test("a new preference revision invalidates motion callbacks and starts an empty new round", async () => {
	const h = harness();
	await h.page.decide(tap(h.page));
	const callbacks = [...h.timers.values()].map((t) => t.callback);
	h.profile.revision++;
	h.profile.answers.flavorIntensity = 80;
	h.page.syncState();
	const before = clone(h.page.data);
	callbacks.forEach((cb) => {
		cb();
	});
	assert.deepEqual(h.page.data, before);
	assert.equal(h.page.data.cards.length, 0);
	assert.equal(h.page._round.snapshot().seenCount, 0);
});
test("hide and unload reject old actions and animation callbacks without writing a record", async () => {
	for (const method of ["onHide", "onUnload"]) {
		const h = harness();
		await h.page.decide(tap(h.page));
		const callbacks = [...h.timers.values()].map((t) => t.callback),
			old = tap(h.page);
		h.page[method]();
		const before = clone(h.page.data);
		callbacks.forEach((cb) => {
			cb();
		});
		await h.page.decide(old);
		assert.deepEqual(h.page.data, before);
		assert.equal(h.historyWrites().length, 0);
		if (method === "onUnload") assert.equal(h.page._round, null);
	}
});
test("drawing never creates a confirmed history record even when historical recording remains enabled", async () => {
	const h = harness();
	h.records.setEnabled(true);
	await h.draw();
	await h.draw();
	assert.equal(h.saved().length, 0);
	assert.equal(h.historyWrites().length, 0);
});
test("same-name foods display their original stall and distinct price suffix", async () => {
	const h = harness();
	await h.choose("番茄鸡排饭", "山东煎饼");
	assert.equal(h.page.data.cards[0].priceNumber, "13");
	assert.equal(h.page.data.cards[0].priceSuffix, "元");
	await h.choose("番茄鸡排饭", "韩式拌饭");
	assert.equal(h.page.data.cards[0].priceNumber, "14");
	assert.equal(h.page.data.cards[0].priceSuffix, "元/份");
});
test("one round displays all 87 IDs once and the next explicit button press starts a fresh round", async () => {
	const h = harness({ reducedMotion: true }),
		ids = new Set();
	for (let i = 0; i < 87; i++) {
		await h.draw();
		const id = h.page.data.cards[0].id;
		assert.ok(!ids.has(id));
		ids.add(id);
	}
	assert.equal(h.page.data.decisionLabel, "重新决定");
	assert.equal(h.page._round.snapshot().remainingCount, 0);
	await h.draw();
	assert.equal(h.page._round.snapshot().seenCount, 1);
	assert.equal(h.randomCalls(), 88);
});
test("an empty constrained pool stays empty and never silently falls back to the full menu", async () => {
	const h = harness();
	h.page._round.configure({ category: "not-in-menu" });
	h.page.render();
	await h.draw();
	assert.equal(h.page.data.status, "empty");
	assert.equal(h.page.data.cards.length, 0);
	assert.equal(h.randomCalls(), 0);
});
test("privacy epoch changes invalidate the prior card and its button event on page return", async () => {
	const h = harness();
	await h.draw();
	const old = tap(h.page);
	h.page.onHide();
	h.app.globalData.canteenEpoch++;
	h.page.onShow();
	await h.page.decide(old);
	assert.equal(h.page.data.cards.length, 0);
	assert.equal(h.page._round.snapshot().seenCount, 0);
});
test("paper-card bindings retain long names, full pricing and reduced-motion support", async () => {
	const h = harness(),
		wxml = fs.readFileSync(path.join(ROOT, "pages/canteen/index.wxml"), "utf8"),
		css = fs.readFileSync(path.join(ROOT, "pages/canteen/index.wxss"), "utf8");
	for (const match of wxml.matchAll(
		/(?:bind|catch)(?::?[a-z]+)="([A-Za-z]\w*)"/g,
	))
		assert.equal(typeof h.page[match[1]], "function");
	assert.match(wxml, /实付按所选重量计算/);
	assert.match(css, /prefers-reduced-motion/);
	await h.choose("生烫牛肉米线（02：米线+青菜+卤蛋+牛肉丸+肉酱）");
	assert.equal(
		h.page.data.cards[0].name,
		"生烫牛肉米线（02：米线+青菜+卤蛋+牛肉丸+肉酱）",
	);
	assert.equal(h.page.data.cards[0].originalPriceText, "13元");
});
test("declining separate MiMo consent keeps the decision on device without a request", async () => {
	const h = harness({ mimo: "ask" }),
		pending = h.page.decide(tap(h.page));
	assert.equal(h.modals.length, 1);
	assert.equal(h.requests.length, 0);
	h.modals[0].success({ confirm: false });
	await pending;
	h.flushTimers();
	assert.equal(h.requests.length, 0);
	assert.equal(h.page.data.decisionSource, "规则推荐");
});
test("a valid MiMo response selects only its ID and reads name and price from the local menu", async () => {
	const h = harness({ mimo: "enabled" }),
		pending = h.page.decide(tap(h.page));
	await tick();
	assert.equal(h.requests.length, 1);
	h.reply({ selectedItemId: "hanshi-banfan-014" });
	await pending;
	h.flushTimers();
	assert.equal(h.page.data.cards[0].name, "鸡肉石锅拌饭");
	assert.equal(h.page.data.decisionSource, "MiMo建议");
	assert.equal(h.randomCalls(), 0);
	assert.match(h.page.data.decisionNote, /尚未核实/);
});
test("server LOCAL provenance is presented honestly as a rule fallback", async () => {
	const h = harness({ mimo: "enabled" }),
		pending = h.page.decide(tap(h.page));
	await tick();
	h.reply({ source: "LOCAL", model: null, fallbackReason: "DISABLED" });
	await pending;
	h.flushTimers();
	assert.equal(h.page.data.decisionSource, "规则推荐");
	assert.match(h.page.data.decisionNote, /尚未启用/);
});
test("unknown, extra and inconsistent model fields trigger a real local fallback", async () => {
	for (const patch of [
		{ selectedItemId: "not-on-menu" },
		{ price: 1 },
		{ source: "MIMO", model: "deepseek" },
		{ preferenceRevision: 999 },
		{ fallbackReason: "DISABLED" },
	]) {
		const h = harness({ mimo: "enabled" }),
			pending = h.page.decide(tap(h.page));
		await tick();
		h.reply(patch);
		await pending;
		h.flushTimers();
		assert.equal(h.page.data.decisionSource, "规则推荐");
		assert.equal(h.randomCalls(), 1);
		assert.equal(h.page._round.snapshot().seenCount, 1);
	}
});
test("hiding aborts an in-flight MiMo request and rejects its delayed successful callback", async () => {
	const h = harness({ mimo: "enabled" }),
		pending = h.page.decide(tap(h.page));
	await tick();
	h.page.onHide();
	assert.equal(h.requests[0].aborted, true);
	h.reply();
	await pending;
	h.flushTimers();
	assert.equal(h.page.data.cards.length, 0);
	assert.equal(h.historyWrites().length, 0);
});
test("a preference edit during MiMo processing rejects the old response before rendering", async () => {
	const h = harness({ mimo: "enabled" }),
		pending = h.page.decide(tap(h.page));
	await tick();
	h.profile.revision++;
	h.profile.answers.spicyLevel = 0;
	h.reply();
	await pending;
	h.flushTimers();
	assert.equal(h.page.data.cards.length, 0);
	assert.equal(h.page._round.snapshot().seenCount, 0);
});
test("withdrawal cancels a pending request and a late result cannot revive consent", async () => {
	const h = harness({ mimo: "enabled" }),
		pending = h.page.decide(tap(h.page));
	await tick();
	h.page.onHide();
	h.ai.withdraw();
	h.reply();
	await pending;
	assert.equal(h.ai.preference(), "disabled");
	assert.equal(h.page.data.cards.length, 0);
});
test("an already shown model ID is rejected and the fallback chooses an unseen dish", async () => {
	const h = harness({ mimo: "enabled" });
	let pending = h.page.decide(tap(h.page));
	await tick();
	h.reply();
	await pending;
	h.flushTimers();
	const old = h.page.data.cards[0].id;
	pending = h.page.decide(tap(h.page));
	await tick();
	assert.ok(h.requests[1].options.data.excludedItemIds.includes(old));
	h.reply({ selectedItemId: old });
	await pending;
	h.flushTimers();
	assert.notEqual(h.page.data.cards[0].id, old);
	assert.equal(h.page.data.decisionSource, "规则推荐");
});
test("requests use only the fixed public API and the two declared preferences without account or location fields", async () => {
	const h = harness({ mimo: "enabled" }),
		pending = h.page.decide(tap(h.page));
	await tick();
	const request = h.requests[0].options;
	assert.equal(request.url, "https://api.eatwhat.pro/v1/canteen/decisions");
	assert.equal(request.header["X-ChiShenMe-Contract-Version"], "1");
	assert.deepEqual(
		Object.keys(request.data).sort(),
		[
			"requestId",
			"menuVersion",
			"preferenceRevision",
			"consentVersion",
			"preferences",
			"excludedItemIds",
		].sort(),
	);
	assert.deepEqual(clone(request.data.preferences), {
		spicyLevel: 2,
		flavorIntensity: 50,
	});
	assert.equal(
		Object.keys(request.header).some((key) => /key|authorization/i.test(key)),
		false,
	);
	h.reply();
	await pending;
	h.flushTimers();
});
test("history starts disabled and its navigation is active-page only", () => {
	const h = harness(),
		history = h.makePage("canteen-records");
	assert.equal(history.data.enabled, false);
	assert.deepEqual(history.data.entries, []);
	history.openCanteen();
	assert.equal(h.calls.at(-1).value.url, "/pages/canteen/index");
	history.onHide();
	const length = h.calls.length;
	history.openCanteen();
	assert.equal(h.calls.length, length);
});
test("history displays fixed, selected-size and weight records with no fabricated paid amount", () => {
	const h = harness();
	h.record("鸡肉石锅拌饭");
	h.record("虾三鲜馄饨", "large");
	h.record("麻辣香锅");
	const history = h.makePage("canteen-records");
	assert.equal(history.data.entries.length, 3);
	assert.equal(history.data.entries[0].weighted, true);
	assert.equal(history.data.entries[1].variantName, "大份");
	assert.equal(history.data.entries[1].priceText, "大份14元");
	assert.equal(history.data.entries[2].name, "鸡肉石锅拌饭");
});
test("history clear requires a positive confirmation and cancelling preserves every record", () => {
	const h = harness();
	h.record("鸡肉石锅拌饭");
	const history = h.makePage("canteen-records");
	history.clearRecords();
	h.modals[0].success({ confirm: false });
	assert.equal(h.saved().length, 1);
	history.clearRecords();
	h.modals[1].success({ confirm: true });
	assert.equal(h.saved().length, 0);
	assert.equal(history.data.enabled, true);
});
test("late history clear callbacks cannot delete after hide, unload or epoch change", () => {
	for (const action of ["onHide", "onUnload", "epoch"]) {
		const h = harness();
		h.record("鸡肉石锅拌饭");
		const history = h.makePage("canteen-records");
		history.clearRecords();
		if (action === "epoch") {
			h.app.globalData.canteenEpoch++;
			history.syncState();
		} else history[action]();
		h.modals[0].success({ confirm: true });
		assert.equal(h.saved().length, 1);
	}
});
test("history failed cleanup remains actionable and prevents new record writes until recovered", () => {
	const h = harness();
	h.record("鸡肉石锅拌饭");
	const history = h.makePage("canteen-records");
	h.failStorage("remove", h.recordsModule.KEY);
	history.changeRemember({ detail: { value: false } });
	assert.equal(history.data.enabled, false);
	assert.equal(history.data.cleanupNeeded, true);
	assert.match(history.data.error, /清除失败/);
	history.syncState();
	assert.equal(history.data.cleanupNeeded, true);
	h.recoverStorage();
	history.retryCleanup();
	assert.equal(history.data.cleanupNeeded, false);
	assert.equal(h.saved().length, 0);
});
test("historical menu v1 entries retain deleted names and prices without becoming current candidates", () => {
	const h = harness(),
		archive = require("../data/canteen-history-catalogs.json").catalogs[0],
		item = archive.menu.items.find((item) => item.name === "牛肉馄饨");
	h.storage.set(h.recordsModule.ENABLED_KEY, true);
	h.storage.set(
		h.recordsModule.KEY,
		JSON.stringify({
			schemaVersion: 1,
			entries: [
				{
					recordedAtEpochMillis: 2000000000000,
					menuVersion: archive.menu.version,
					itemId: item.id,
					stallId: item.stallId,
					variantId: null,
					variantName: null,
					priceKind: "fixed",
					amountFen: item.price.amountFen,
					unit: item.price.unit,
					priceText: item.originalPriceText,
				},
			],
		}),
	);
	const history = h.makePage("canteen-records");
	assert.equal(history.data.entries[0].name, "牛肉馄饨");
	assert.equal(history.data.entries[0].priceText, item.originalPriceText);
	assert.ok(
		!h.decision
			.getCandidates()
			.candidates.some((candidate) => candidate.item.id === item.id),
	);
});

test("routes add both canteen pages and home keeps its left-aligned location entry and existing decision controls", () => {
	const config = JSON.parse(
		fs.readFileSync(path.join(ROOT, "app.json"), "utf8"),
	);
	for (const route of [
		"pages/index/index",
		"pages/canteen/index",
		"pages/canteen-records/index",
		"pages/location/index",
		"pages/conditions/index",
		"pages/results/index",
		"pages/account/index",
	]) {
		assert.ok(config.pages.includes(route), route);
	}
	const home = fs.readFileSync(
		path.join(ROOT, "pages/index/index.wxml"),
		"utf8",
	);
	const css = fs.readFileSync(
		path.join(ROOT, "pages/index/index.wxss"),
		"utf8",
	);
	assert.match(home, /data-page="canteen" bindtap="open"/);
	assert.match(home, /data-page="canteen-records" bindtap="open"/);
	assert.match(home, /帮你决定在学校食堂吃什么/);
	assert.match(home, /class="location" bindtap="open" data-page="location"/);
	assert.match(home, /class="location-current">虚拟地点/);
	assert.match(home, /data-target="PACKAGE"/);
	assert.match(home, /data-target="RESTAURANT"/);
	assert.match(home, /bindtap="decide"/);
	assert.ok(
		home.indexOf('class="location"') < home.indexOf('class="canteen-entry"'),
	);
	assert.match(
		css,
		/button\.location\s*\{[^}]*justify-content:flex-start;[^}]*padding:0;[^}]*text-align:left;[^}]*margin:0;/,
	);
	const settings = JSON.parse(
		fs.readFileSync(path.join(ROOT, "pages/canteen/index.json"), "utf8"),
	);
	assert.equal(settings.navigationBarTitleText, "食堂吃什么");
});

test("the real home routing handler opens canteen and location without requesting cloud consent", async () => {
	let definition;
	const navigations = [];
	const source = fs.readFileSync(
		path.join(ROOT, "pages/index/index.js"),
		"utf8",
	);
	const context = vm.createContext({
		Page(value) {
			definition = value;
		},
		wx: {
			navigateTo(value) {
				navigations.push(value.url);
			},
			showToast() {
				assert.fail("Offline routes must not request consent");
			},
		},
		getApp: () => ({
			ensureTasteProfile: () => true,
			checkService() {
				assert.fail("Offline routes must not connect to cloud");
			},
		}),
	});
	const execute = new vm.Script(
		`(function(require){\n${source}\n})`,
	).runInContext(context);
	execute((request) => {
		if (request === "../../lib/service")
			return { VERSION: "test", state: { consent: false, status: "failed" } };
		if (request === "../../lib/decision/service") return {};
		if (request === "../../lib/home-title") return require("../lib/home-title");
		assert.fail(`Unexpected home routing dependency ${request}`);
	});
	const home = {
		...definition,
		_active: true,
		data: clone(definition.data),
		setData(value) {
			Object.assign(this.data, clone(value));
		},
	};
	for (const page of [
		"canteen",
		"canteen-records",
		"location",
		"conditions",
		"settings",
	]) {
		await home.open({ currentTarget: { dataset: { page } } });
	}
	assert.deepEqual(
		navigations,
		["canteen", "canteen-records", "location", "conditions", "settings"].map(
			(page) => `/pages/${page}/index`,
		),
	);
});
