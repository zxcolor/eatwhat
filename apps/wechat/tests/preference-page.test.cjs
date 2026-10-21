const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const model = require("../lib/decision/taste-profile");
const copy = (value) => JSON.parse(JSON.stringify(value));
const COMPLETE = { spicyLevel: 2, flavorIntensity: 50 };
const { getHomeTitle } = require("../lib/home-title");
const nextTimerTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options = {}) {
	let definition;
	const calls = [];
	const state = {
		started: !!options.started,
		ready: !!options.ready,
		editing: false,
		revision: 0,
		answers: copy(options.answers || {}),
		error: "",
	};
	const operations = [];
	const store = {
		getState() {
			return copy(state);
		},
		start() {
			operations.push({ type: "start" });
			if (options.startError)
				throw new Error("raw-storage-error providerSecret=never-render");
			state.started = true;
			state.revision += 1;
			return this.getState();
		},
		beginEdit() {
			operations.push({ type: "beginEdit" });
			state.started = true;
			state.editing = state.ready;
			state.revision += 1;
			return this.getState();
		},
		answer(field, value, revision) {
			assert.equal(revision, state.revision);
			const next = model.normalizeAnswers({ ...state.answers, [field]: value });
			state.answers = copy(next);
			state.revision += 1;
			operations.push({ type: "answer", field, value: copy(value), revision });
			return this.getState();
		},
		assess() {
			operations.push({ type: "assess" });
			const missingFields = model.missingFields(state.answers);
			const ready = missingFields.length === 0 && !options.infeasible;
			return {
				ready,
				profileComplete: missingFields.length === 0,
				missingFields,
				message: options.infeasible
					? "当前条件下没有可选结果，请调整偏好。"
					: ready
						? "将按你的选择为你决定。"
						: "请完成每一项偏好选择。",
			};
		},
	};
	const app = {
		syncPage(page) {
			page.setData({ themeClass: "theme-dark" });
		},
		completeTasteProfile(revision) {
			operations.push({ type: "complete", revision });
			assert.equal(revision, state.revision);
			return options.complete ? options.complete() : undefined;
		},
	};
	const wx = new Proxy(
		{},
		{
			get(_target, key) {
				if (/Storage|request|getLocation|login/i.test(String(key)))
					return () => {
						throw new Error(`Unexpected page platform call: ${String(key)}`);
					};
				return (value) => {
					calls.push({ type: key, value });
					if (key === "reLaunch" && options.reLaunch) options.reLaunch(value);
				};
			},
		},
	);
	vm.runInNewContext(
		fs.readFileSync(
			path.join(__dirname, "../pages/preferences/index.js"),
			"utf8",
		),
		{
			require(id) {
				if (id === "../../lib/taste-profile") return store;
				if (id === "../../lib/decision/taste-profile") return model;
				if (id === "../../lib/home-title") return { getHomeTitle };
				throw new Error(`Unexpected module ${id}`);
			},
			Page(value) {
				definition = value;
			},
			getApp: () => app,
			wx,
			setTimeout(callback, delay) {
				const timer = setTimeout(callback, delay);
				if (delay >= 1000) timer.unref();
				return timer;
			},
			clearTimeout,
		},
	);
	const page = {
		...definition,
		data: copy(definition.data),
		setData(update) {
			Object.assign(this.data, copy(update));
		},
	};
	page.onLoad(options.route || {});
	const event = (extra) => ({
		currentTarget: { dataset: { revision: page.data.revision, ...extra } },
	});
	return { page, state, store, operations, calls, event };
}
function count(h, type) {
	return h.operations.filter((operation) => operation.type === type).length;
}

function drag(h, field, value, extra = {}) {
	h.page.onSliderCommit({
		detail: {
			field,
			value,
			revision: h.page.data.revision,
			dragged: true,
			...extra,
		},
	});
}
function both(h) {
	drag(h, "spicyLevel", 2);
	drag(h, "flavorIntensity", 50);
}

test("two displayed defaults save no answers and cannot reveal the entry button", () => {
	const h = harness();
	h.page.onShow();
	assert.equal(h.page.data.spicyValue, 0);
	assert.equal(h.page.data.intensityValue, 50);
	assert.equal(h.page.data.showEnter, false);
	assert.equal(h.operations.length, 0);
	assert.deepEqual(h.state.answers, {});
	assert.equal(h.page.data.themeClass, "theme-dark");
	assert.equal(
		h.calls.find((c) => c.type === "setNavigationBarTitle").value.title,
		getHomeTitle(),
	);
});
test("a restored partial draft requires both sliders to be dragged during this page visit", () => {
	const h = harness({ started: true, answers: { spicyLevel: 4 } });
	h.page.onShow();
	assert.equal(h.page.data.spicyValue, 4);
	assert.equal(h.page.data.showEnter, false);
	drag(h, "flavorIntensity", 60);
	assert.equal(h.page.data.showEnter, false);
	drag(h, "spicyLevel", 4);
	assert.equal(h.page.data.showEnter, true);
	assert.deepEqual(h.state.answers, { spicyLevel: 4, flavorIntensity: 60 });
	assert.equal(count(h, "start"), 0);
});
test("native input previews do not save or qualify either slider", () => {
	const h = harness();
	h.page.onShow();
	for (const [field, value] of Object.entries(COMPLETE))
		h.page.onSliderInput({ detail: { field, value, revision: 0 } });
	assert.equal(count(h, "answer"), 0);
	assert.deepEqual(h.state.answers, {});
	assert.equal(h.page.data.showEnter, false);
});
test("a reset or un-dragged native change never qualifies as an intentional drag", () => {
	const h = harness();
	h.page.onShow();
	drag(h, "spicyLevel", 2, { dragged: false });
	assert.equal(count(h, "answer"), 0);
	both(h);
	assert.equal(h.page.data.showEnter, true);
	h.page.onSliderReset({
		detail: { field: "spicyLevel", value: 0, revision: h.page.data.revision },
	});
	assert.equal(h.page.data.showEnter, false);
	assert.equal(h.state.answers.spicyLevel, 0);
});
test("invalid field, coercion, fraction and out-of-range events cannot persist answers", () => {
	const h = harness();
	h.page.onShow();
	for (const [field, value] of [
		["apiKey", 1],
		["budgetCents", 10],
		["spicyLevel", 7],
		["spicyLevel", "2"],
		["spicyLevel", 1.5],
		["flavorIntensity", 101],
		["flavorIntensity", NaN],
	])
		drag(h, field, value);
	assert.equal(count(h, "answer"), 0);
	assert.equal(h.operations.length, 0);
});
test("stale revision and hidden component events cannot modify a newer draft", () => {
	const h = harness({ started: true });
	h.page.onShow();
	h.state.revision++;
	drag(h, "spicyLevel", 2, { revision: 0 });
	assert.equal(count(h, "answer"), 0);
	assert.equal(h.page.data.revision, h.state.revision);
	h.page.onHide();
	both(h);
	assert.equal(count(h, "answer"), 0);
});
test("an assessment rejection keeps finish blocked even after both valid gestures", async () => {
	const h = harness({ infeasible: true });
	h.page.onShow();
	both(h);
	await h.page.finish(h.event());
	assert.equal(count(h, "complete"), 0);
});
test("only both dragged answers confirm once and repeated finish waits for completion", async () => {
	let done;
	const pending = new Promise((r) => {
		done = r;
	});
	const h = harness({ complete: () => pending });
	h.page.onShow();
	both(h);
	const finishing = h.page.finish(h.event());
	await h.page.finish(h.event());
	assert.equal(count(h, "complete"), 1);
	assert.equal(h.page.data.busy, true);
	done();
	await finishing;
	assert.equal(h.page.data.busy, false);
});
test("late confirmation failure after leaving cannot overwrite a newer visible page", async () => {
	let reject;
	const pending = new Promise((_r, r) => {
		reject = r;
	});
	const h = harness({ complete: () => pending });
	h.page.onShow();
	both(h);
	const finishing = h.page.finish(h.event());
	h.page.onHide();
	h.page.onShow();
	const before = copy(h.page.data);
	reject(new Error("raw-response secret=never-render"));
	await finishing;
	assert.deepEqual(h.page.data, before);
	h.page.syncState();
	assert.equal(h.page.data.busy, false);
});
test("confirmed cold start navigates after onShow while explicit edit begins a draft only once", async () => {
	const h = harness({ ready: true, answers: COMPLETE });
	h.page.onShow();
	h.page.syncState();
	assert.equal(
		h.calls.some((c) => c.type === "reLaunch"),
		false,
	);
	await nextTimerTurn();
	assert.equal(h.calls.filter((c) => c.type === "reLaunch").length, 1);
	const edit = harness({
		ready: true,
		answers: COMPLETE,
		route: { edit: "1" },
	});
	edit.page.onShow();
	edit.page.onHide();
	edit.page.onShow();
	await nextTimerTurn();
	assert.equal(count(edit, "beginEdit"), 1);
	assert.equal(edit.state.started, true);
	assert.equal(edit.page.data.showEnter, false);
	assert.equal(
		edit.calls.some((c) => c.type === "reLaunch"),
		false,
	);
});
test("hiding or unloading cancels pending confirmed-profile navigation", async () => {
	for (const leave of ["onHide", "onUnload"]) {
		const h = harness({ ready: true, answers: COMPLETE });
		h.page.onShow();
		h.page[leave]();
		await nextTimerTurn();
		assert.equal(
			h.calls.some((c) => c.type === "reLaunch"),
			false,
		);
	}
});
test("returning before an old home timer runs navigates only in the new generation", async () => {
	const h = harness({ ready: true, answers: COMPLETE });
	h.page.onShow();
	h.page.onHide();
	h.page.onShow();
	await nextTimerTurn();
	assert.equal(h.calls.filter((c) => c.type === "reLaunch").length, 1);
});
test("queued navigation rechecks readiness, open drafts and edit intent immediately before navigating", async () => {
	for (const mutate of [
		(h) => {
			h.state.ready = false;
		},
		(h) => {
			h.state.started = true;
		},
		(h) => {
			h.page._editRequested = true;
		},
	]) {
		const h = harness({ ready: true, answers: COMPLETE });
		h.page.onShow();
		mutate(h);
		await nextTimerTurn();
		assert.equal(
			h.calls.some((c) => c.type === "reLaunch"),
			false,
		);
	}
});
test("native navigation failures are safe and a previous callback cannot affect a new visit", async () => {
	const h = harness({ ready: true, answers: COMPLETE });
	h.page.onShow();
	await nextTimerTurn();
	const old = h.calls.find((c) => c.type === "reLaunch").value;
	h.page.onHide();
	h.state.started = true;
	h.page.onShow();
	const before = copy(h.page.data);
	old.fail({ errMsg: "PRIVATE_ROUTER" });
	assert.deepEqual(h.page.data, before);
	const failed = harness({
		ready: true,
		answers: COMPLETE,
		reLaunch: () => {
			throw Error("PRIVATE_ROUTER");
		},
	});
	failed.page.onShow();
	await nextTimerTurn();
	assert.equal(failed.page.data.error, "暂时无法进入首页，请重试。");
	assert.doesNotMatch(JSON.stringify(failed.page.data), /PRIVATE_ROUTER/);
});
test("an edit route without an active profile still accepts the two sliders", () => {
	const h = harness({ route: { edit: "1" } });
	h.page.onShow();
	assert.equal(h.state.started, true);
	both(h);
	assert.equal(h.page.data.showEnter, true);
});
test("failed initial persistence preserves the unanswered page and redacts raw errors", () => {
	const h = harness({ startError: true });
	h.page.onShow();
	drag(h, "spicyLevel", 2);
	assert.equal(h.state.started, false);
	assert.equal(h.page.data.showEnter, false);
	assert.equal(h.page.data.error, "暂时无法保存口味，请重试。");
	assert.doesNotMatch(
		JSON.stringify(h.page.data),
		/providerSecret|raw-storage-error/,
	);
});
test("an external revision invalidates earlier drag qualifications without changing stored answers", () => {
	const h = harness();
	h.page.onShow();
	both(h);
	const answers = copy(h.state.answers);
	h.state.revision++;
	h.page.syncState();
	assert.equal(h.page.data.showEnter, false);
	assert.deepEqual(h.state.answers, answers);
	drag(h, "spicyLevel", 2);
	assert.equal(h.page.data.showEnter, false);
	drag(h, "flavorIntensity", 50);
	assert.equal(h.page.data.showEnter, true);
});
test("both extreme endpoints remain valid explicit values", () => {
	for (const [spicyLevel, flavorIntensity] of [
		[0, 0],
		[6, 100],
	]) {
		const h = harness();
		h.page.onShow();
		drag(h, "spicyLevel", spicyLevel);
		drag(h, "flavorIntensity", flavorIntensity);
		assert.equal(h.page.data.showEnter, true);
		assert.deepEqual(h.state.answers, { spicyLevel, flavorIntensity });
	}
});
test("finish cannot race an active drag and only resumes after dragstate ends", async () => {
	const h = harness();
	h.page.onShow();
	both(h);
	h.page.onSliderDragState({ detail: { field: "spicyLevel", dragging: true } });
	await h.page.finish(h.event());
	assert.equal(count(h, "complete"), 0);
	h.page.onSliderDragState({
		detail: { field: "spicyLevel", dragging: false },
	});
	await h.page.finish(h.event());
	assert.equal(count(h, "complete"), 1);
});
test("a stale entry-button event cannot confirm a newly updated slider revision", async () => {
	const h = harness();
	h.page.onShow();
	both(h);
	const stale = h.event();
	drag(h, "flavorIntensity", 60);
	await h.page.finish(stale);
	assert.equal(count(h, "complete"), 0);
	await h.page.finish(h.event());
	assert.equal(count(h, "complete"), 1);
});
