const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "../..");
const clone = (value) =>
	value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tap = (page) => ({
	currentTarget: { dataset: { revision: page.data.revision } },
});
function harness(options = {}) {
	const calls = [],
		requests = [],
		modals = [],
		storage = new Map(),
		faults = new Set(),
		timers = new Map(),
		modules = new Map();
	let now = 2000000000000,
		timerId = 0,
		randomValue = 0,
		randomCalls = 0,
		definition;
	const profile = {
		ready: options.ready !== false,
		revision: 1,
		answers: { spicyLevel: 2, flavorIntensity: 50 },
	};
	const consentKey = "eatwhat.wechat.canteen-mimo-consent.v1";
	if (options.mimo !== "ask")
		storage.set(consentKey, {
			version: "canteen-mimo-v1",
			enabled: options.mimo === "enabled",
		});
	function guard(operation, key) {
		if (faults.has(`${operation}:${key}`))
			throw Error("PRIVATE_NATIVE_FAILURE");
	}
	const wx = {
		getStorageSync(key) {
			guard("get", key);
			return clone(storage.get(key));
		},
		setStorageSync(key, value) {
			guard("set", key);
			calls.push({ name: "setStorageSync", key });
			storage.set(key, clone(value));
		},
		removeStorageSync(key) {
			guard("remove", key);
			storage.delete(key);
		},
		hideShareMenu() {},
		showToast(value) {
			calls.push({ name: "showToast", value });
		},
		navigateTo(value) {
			calls.push({ name: "navigateTo", value });
		},
		navigateBack(value) {
			calls.push({ name: "navigateBack", value });
		},
		showModal(value) {
			modals.push(value);
		},
		request(value) {
			const request = { options: value, aborted: false };
			requests.push(request);
			return {
				abort() {
					request.aborted = true;
					value.fail?.({ errMsg: "request:fail abort" });
				},
			};
		},
		getLocation() {
			assert.fail("No location in canteen");
		},
		login() {
			assert.fail("No account in canteen");
		},
	};
	const app = {
		globalData: { canteenEpoch: 0 },
		syncPage(page) {
			page.setData({
				themeClass: "theme-light",
				reducedMotion: !!options.reducedMotion,
			});
		},
		ensureTasteProfile(value) {
			calls.push({ name: "ensureTasteProfile", value });
			return profile.ready;
		},
	};
	const math = Object.create(Math);
	math.random = () => {
		randomCalls++;
		return randomValue;
	};
	const context = vm.createContext({
		wx,
		Math: math,
		Date: class extends Date {
			static now() {
				return now;
			}
		},
		getApp: () => app,
		Page(value) {
			definition = value;
		},
		setTimeout(callback, delay) {
			const id = ++timerId;
			timers.set(id, { callback, delay });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
	});
	const allowed = new Set([
		"lib/canteen-ai.js",
		"lib/canteen-decision.js",
		"lib/canteen-records.js",
		"lib/decision-motion.js",
		"data/canteen-menu.js",
		"data/canteen-policy.js",
		"data/canteen-taste-policy.js",
		"data/canteen-history-catalogs.js",
	]);
	const taste = {
		getState: () => ({ revision: profile.revision }),
		getProfile: () => (profile.ready ? clone(profile.answers) : null),
	};
	function load(request, parent = path.join(ROOT, "entry.js")) {
		let filename = path.resolve(path.dirname(parent), request);
		if (!path.extname(filename)) filename += ".js";
		const relative = path.relative(ROOT, filename).replaceAll("\\", "/");
		if (relative === "lib/taste-profile.js") return taste;
		assert.ok(allowed.has(relative), `Unexpected canteen module ${relative}`);
		if (modules.has(filename)) return modules.get(filename).exports;
		const module = { exports: {} };
		modules.set(filename, module);
		new vm.Script(
			`(function(require,module,exports){\n${fs.readFileSync(filename, "utf8")}\n})`,
			{ filename },
		).runInContext(context)((id) => load(id, filename), module, module.exports);
		return module.exports;
	}
	const decision = load("./lib/canteen-decision"),
		recordsModule = load("./lib/canteen-records");
	const records = recordsModule.createCanteenRecords({
		storage: wx,
		now: () => now,
	});
	const ai = load("./lib/canteen-ai"),
		menu = load("./data/canteen-menu");
	function makePage(name = "canteen") {
		const filename = path.join(ROOT, `pages/${name}/index.js`);
		new vm.Script(
			`(function(require){\n${fs.readFileSync(filename, "utf8")}\n})`,
			{ filename },
		).runInContext(context)((id) =>
			id === "../../lib/canteen-records" ? records : load(id, filename),
		);
		const page = {
			...definition,
			data: clone(definition.data),
			setData(update, callback) {
				Object.assign(this.data, clone(update));
				callback?.();
			},
		};
		page.onLoad?.();
		page.onShow();
		return page;
	}
	const page = makePage();
	function flushTimers() {
		for (let i = 0; timers.size && i < 20; i++) {
			const entries = [...timers];
			timers.clear();
			for (const [, timer] of entries) timer.callback();
		}
		assert.equal(timers.size, 0);
	}
	async function draw() {
		await page.decide(tap(page));
		flushTimers();
	}
	async function choose(name, stall) {
		const seen = new Set(page._round.snapshot().seenIds);
		const candidates = decision
			.getCandidates()
			.candidates.filter((c) => !seen.has(c.item.id));
		const index = candidates.findIndex(
			(c) => c.item.name === name && (!stall || c.stall.name === stall),
		);
		assert.ok(index >= 0);
		randomValue = (index + 0.5) / candidates.length;
		await draw();
	}
	function reply(patch = {}, index = requests.length - 1) {
		const request = requests[index],
			input = request.options.data;
		const item = menu.items.find(
			(item) => !input.excludedItemIds.includes(item.id),
		);
		const data = {
			requestId: input.requestId,
			menuVersion: input.menuVersion,
			preferenceRevision: input.preferenceRevision,
			status: "SELECTED",
			selectedItemId: item?.id,
			source: "MIMO",
			model: "mimo-v2.6-flash",
			fallbackReason: null,
			notice: "TASTE_ATTRIBUTES_UNVERIFIED",
			...patch,
		};
		request.options.success({
			statusCode: 200,
			header: { "X-ChiShenMe-Contract-Version": "1" },
			data,
		});
	}
	function record(name, variantId, stall) {
		const item = menu.items.find(
			(item) => item.name === name && (!stall || item.stallId === stall),
		);
		assert.ok(item);
		const round = decision.createRound();
		round.choose(item.id);
		if (item.price.kind === "variants")
			round.selectVariant(variantId || item.price.variants[0].id);
		records.setEnabled(true);
		records.recordChoice(round.confirmation());
		now++;
		return item;
	}
	return {
		page,
		profile,
		app,
		ai,
		menu,
		decision,
		records,
		recordsModule,
		calls,
		requests,
		modals,
		storage,
		timers,
		draw,
		choose,
		reply,
		record,
		makePage,
		flushTimers,
		randomCalls: () => randomCalls,
		advance: (ms) => {
			now += ms;
		},
		failStorage: (op, key) => faults.add(`${op}:${key}`),
		recoverStorage: () => faults.clear(),
		historyWrites: () =>
			calls.filter(
				(call) =>
					call.name === "setStorageSync" && call.key === recordsModule.KEY,
			),
		saved: () => records.list(),
		clone,
	};
}
module.exports = { harness, tap, ROOT, clone };
