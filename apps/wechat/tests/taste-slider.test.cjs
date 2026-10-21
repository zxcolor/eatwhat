const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { TIMING } = require("../lib/decision-motion");
const { SPICY_LEVELS } = require("../lib/decision/taste-profile");
function host(patch = {}) {
	let definition,
		id = 0;
	const events = [],
		timers = new Map();
	vm.runInNewContext(
		fs.readFileSync(
			require.resolve("../components/taste-slider/index"),
			"utf8",
		),
		{
			Component(value) {
				definition = value;
			},
			require(name) {
				assert.equal(name, "../../lib/decision-motion");
				return { TIMING };
			},
			setTimeout(fn) {
				const key = ++id;
				timers.set(key, fn);
				return key;
			},
			clearTimeout(key) {
				timers.delete(key);
			},
		},
	);
	const properties = Object.fromEntries(
		Object.entries(definition.properties).map(([key, spec]) => [
			key,
			spec.value,
		]),
	);
	Object.assign(
		properties,
		{
			field: "spicyLevel",
			min: 0,
			max: 6,
			step: 1,
			labels: [...SPICY_LEVELS],
			revision: 7,
		},
		patch,
	);
	const component = {
		...definition.methods,
		properties,
		data: JSON.parse(JSON.stringify(definition.data)),
		setData(value) {
			Object.assign(this.data, JSON.parse(JSON.stringify(value)));
		},
		triggerEvent(name, detail) {
			events.push({ name, detail: JSON.parse(JSON.stringify(detail)) });
		},
	};
	definition.lifetimes.attached.call(component);
	const point = (x = 100, y = 50, identifier = 1) => ({
		clientX: x,
		clientY: y,
		identifier,
	});
	return {
		component,
		events,
		timers,
		point,
		start() {
			component.touchStart({ touches: [point()] });
		},
		move(x, y = 50) {
			component.touchMove({ touches: [point(x, y)] });
		},
		end(x = 120, y = 50) {
			component.touchEnd({ touches: [], changedTouches: [point(x, y)] });
		},
		flush() {
			for (const [key, fn] of [...timers]) {
				timers.delete(key);
				fn();
			}
		},
		hide() {
			definition.pageLifetimes.hide.call(component);
		},
		detach() {
			definition.lifetimes.detached.call(component);
		},
		update(value) {
			Object.assign(properties, value);
			component.syncProperties();
		},
		commits() {
			return events.filter((event) => event.name === "commit");
		},
	};
}
test("only maximum discrete spice uses Ultra while continuous intensity always stays blue", () => {
	for (let value = 0; value <= 6; value++) {
		const h = host({ value });
		assert.equal(h.component.data.isUltra, value === 6);
		assert.equal(h.component.data.displayLabel, SPICY_LEVELS[value]);
	}
	const h = host({
		field: "flavorIntensity",
		max: 100,
		labels: [],
		value: 100,
	});
	assert.equal(h.component.data.isUltra, false);
	assert.equal(h.component.data.ticks.length, 0);
	assert.equal(h.component.data.particles.length, 14);
});
test("horizontal movement commits the exact controlled value once on release", () => {
	const h = host();
	h.start();
	h.component.nativeChanging({ detail: { value: 4 } });
	h.move(120);
	assert.equal(h.component.data.displayValue, 4);
	assert.equal(h.commits().length, 0);
	h.component.nativeChange({ detail: { value: 5 } });
	h.end();
	h.flush();
	assert.deepEqual(
		h.commits().map((e) => e.detail),
		[{ field: "spicyLevel", revision: 7, value: 5, dragged: true }],
	);
});
test("native change arriving after touchend commits once without losing the final value", () => {
	const h = host();
	h.start();
	h.move(120);
	h.end();
	h.component.nativeChange({ detail: { value: 6 } });
	h.flush();
	assert.equal(h.commits().length, 1);
	assert.equal(h.commits()[0].detail.value, 6);
});
test("an out-and-back horizontal drag counts even when its final value is unchanged", () => {
	const h = host({ value: 2 });
	h.start();
	h.move(120);
	h.move(100);
	h.end(100);
	h.flush();
	assert.equal(h.commits().length, 1);
	assert.equal(h.commits()[0].detail.value, 2);
});
test("a tap never counts as dragging even if native change supplies a different value", () => {
	const h = host({ value: 2 });
	h.start();
	h.component.nativeChange({ detail: { value: 5 } });
	h.end(101);
	h.flush();
	assert.equal(h.commits().length, 0);
	assert.equal(h.component.data.displayValue, 2);
});
test("a vertical scroll cannot become a horizontal drag later in the same touch", () => {
	const h = host({ value: 2 });
	h.start();
	h.move(100, 65);
	h.component.nativeChanging({ detail: { value: 6 } });
	h.move(150, 65);
	h.end(150, 65);
	h.flush();
	assert.equal(h.commits().length, 0);
	assert.equal(h.component.data.displayValue, 2);
});
test("multitouch and mismatched identifiers cancel the gesture instead of committing", () => {
	for (const touches of [
		[{ clientX: 120, clientY: 50, identifier: 2 }],
		[
			{ clientX: 120, clientY: 50, identifier: 1 },
			{ clientX: 125, clientY: 50, identifier: 2 },
		],
	]) {
		const h = host();
		h.start();
		h.component.touchMove({ touches });
		h.end();
		h.flush();
		assert.equal(h.commits().length, 0);
	}
});
test("touch cancellation restores the original value and rejects delayed native changes", () => {
	const h = host({ value: 1 });
	h.start();
	h.move(120);
	h.component.nativeChanging({ detail: { value: 5 } });
	h.component.touchCancel();
	h.component.nativeChange({ detail: { value: 6 } });
	h.flush();
	assert.equal(h.commits().length, 0);
	assert.equal(h.component.data.displayValue, 1);
});
test("a late input echo does not rewind an active gesture", () => {
	const h = host();
	h.start();
	h.move(120);
	h.component.nativeChanging({ detail: { value: 5 } });
	h.update({ value: 1 });
	assert.equal(h.component.data.displayValue, 5);
	h.end();
	h.flush();
	assert.equal(h.commits()[0].detail.value, 5);
});
test("a changed preference revision cancels the old gesture and its deferred release", () => {
	const h = host({ value: 1 });
	h.start();
	h.move(120);
	h.component.nativeChanging({ detail: { value: 5 } });
	h.end();
	const late = [...h.timers.values()];
	h.update({ revision: 8, value: 3 });
	late.forEach((fn) => {
		fn();
	});
	h.component.nativeChange({ detail: { value: 6 } });
	assert.equal(h.commits().length, 0);
	assert.equal(h.component.data.displayValue, 3);
});
test("hide and detach invalidate deferred release work", () => {
	for (const leave of ["hide", "detach"]) {
		const h = host();
		h.start();
		h.move(120);
		h.end();
		const late = [...h.timers.values()];
		h[leave]();
		late.forEach((fn) => {
			fn();
		});
		assert.equal(h.commits().length, 0);
	}
});
test("disabled and malformed ranges never begin an interactive gesture", () => {
	for (const patch of [
		{ disabled: true },
		{ max: 0 },
		{ step: 0 },
		{ max: NaN },
		{ min: 6, max: 1 },
	]) {
		const h = host(patch);
		h.start();
		h.move(120);
		h.end();
		h.flush();
		assert.equal(h.commits().length, 0);
		assert.equal(h.component.data.controlDisabled, true);
	}
});
test("continuous intensity highlights movement direction and clears it after release", () => {
	const h = host({ field: "flavorIntensity", max: 100, labels: [], value: 50 });
	h.start();
	h.move(85);
	assert.equal(h.component.data.activeSide, "left");
	h.move(110);
	assert.equal(h.component.data.activeSide, "right");
	h.end(110);
	h.flush();
	assert.equal(h.component.data.activeSide, "");
	assert.equal(h.component.data.isUltra, false);
});
