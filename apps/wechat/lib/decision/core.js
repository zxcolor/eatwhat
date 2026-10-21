// biome-ignore lint/suspicious/noRedundantUseStrict: WeChat executes CommonJS wrappers, not ES modules.
"use strict";

// R1-R3: hard facts first, fixed-denominator utility, exact explicit ordering.
// The browser adapter uses camelCase field names; this is not the Python wire schema.
const { Fraction } = require("./rational");
const JSBI = require("./vendor/jsbi");
const { digest, canonical } = require("./digest");
const ZERO = Fraction.from(0),
	ONE = Fraction.from(1);
// biome-ignore lint/suspicious/noPrototypeBuiltins: Do not require ES2022 Object.hasOwn in WeChat.
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function fail(message) {
	const error = new Error(message);
	error.code = "INVALID_DECISION_INPUT";
	throw error;
}
function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function nonempty(value) {
	return typeof value === "string" && value.length > 0;
}
function dictionary() {
	return Object.create(null);
}
function keysOnly(value, keys) {
	if (Object.keys(value).some((key) => !keys.includes(key)))
		fail("Unknown model field");
}
function validEnabled(item) {
	if (has(item, "enabled") && typeof item.enabled !== "boolean")
		fail("enabled must be boolean");
}
function same(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}
function fact(candidate, attribute) {
	return has(candidate.facts, attribute)
		? candidate.facts[attribute]
		: { state: "unknown", source: "missing", version: "missing" };
}
function enabled(items) {
	return items.filter((item) => item.enabled !== false);
}
function predicate(value, op, expected) {
	if (op === "lte" || op === "le") return value <= expected;
	if (op === "gte" || op === "ge") return value >= expected;
	if (op === "eq") return same(value, expected);
	if (op === "in") return expected.some((item) => same(item, value));
	if (op === "contains_any")
		return expected.some((item) => value.includes(item));
	if (op === "contains_all")
		return expected.every((item) => value.includes(item));
	fail("Unknown predicate");
}
function validValue(value, attr) {
	if (attr.type === "number")
		return (
			finite(value) &&
			(attr.minimum === undefined || value >= attr.minimum) &&
			(attr.maximum === undefined || value <= attr.maximum)
		);
	if (attr.type === "boolean") return typeof value === "boolean";
	if (attr.type === "string")
		return nonempty(value) && (!attr.values || attr.values.includes(value));
	return (
		Array.isArray(value) &&
		value.every(nonempty) &&
		new Set(value).size === value.length &&
		(!attr.values || value.every((item) => attr.values.includes(item)))
	);
}
function validatePredicate(condition, attributes, missingAllowed) {
	if (!condition || !has(attributes, condition.attribute))
		fail("Unknown predicate attribute");
	const attr = attributes[condition.attribute];
	if (condition.unit !== undefined && condition.unit !== attr.unit)
		fail("Predicate unit mismatch");
	const ops =
		attr.type === "number"
			? ["eq", "lte", "le", "gte", "ge", "in"]
			: attr.type === "string_set"
				? ["contains_any", "contains_all"]
				: ["eq", "in"];
	if (!ops.includes(condition.op))
		fail("Predicate does not match attribute type");
	if (!has(condition, "value")) {
		if (missingAllowed) return;
		fail("Missing predicate value");
	}
	const valid =
		condition.op === "in"
			? Array.isArray(condition.value) &&
				condition.value.every((value) => validValue(value, attr))
			: validValue(condition.value, attr);
	if (!valid) fail("Invalid predicate value");
}
function validateClause(clause, attributes) {
	if (clause && clause.op === "in_range") {
		const attr = attributes[clause.attribute];
		if (
			attr?.type !== "number" ||
			!finite(clause.lower) ||
			!finite(clause.upper) ||
			clause.lower > clause.upper ||
			(clause.unit !== undefined && clause.unit !== attr.unit)
		)
			fail("Invalid closed interval clause");
	} else {
		validatePredicate(clause, attributes, false);
		if (
			["in", "contains_all", "contains_any"].includes(clause.op) &&
			clause.value.length === 0
		)
			fail("Soft conjunction targets must be nonempty");
	}
}
function clauseValue(value, clause) {
	return clause.op === "in_range"
		? value >= clause.lower && value <= clause.upper
		: predicate(value, clause.op, clause.value);
}
function validate(problem) {
	if (
		!problem ||
		![2, "2"].includes(problem.schema_version) ||
		!problem.attributes ||
		!Array.isArray(problem.candidates)
	)
		fail("Invalid problem");
	for (const attr of Object.values(problem.attributes)) {
		if (
			!attr ||
			!["number", "boolean", "string", "string_set"].includes(attr.type)
		)
			fail("Invalid attribute type");
		if (
			(attr.minimum !== undefined && !finite(attr.minimum)) ||
			(attr.maximum !== undefined && !finite(attr.maximum))
		)
			fail("Invalid attribute range");
		if (
			attr.minimum !== undefined &&
			attr.maximum !== undefined &&
			attr.minimum > attr.maximum
		)
			fail("Inverted attribute range");
		if (
			attr.values &&
			(!Array.isArray(attr.values) ||
				!attr.values.every(nonempty) ||
				new Set(attr.values).size !== attr.values.length)
		)
			fail("Invalid vocabulary");
	}
	const ids = new Set();
	for (const candidate of problem.candidates) {
		if (
			!candidate ||
			!nonempty(candidate.id) ||
			ids.has(candidate.id) ||
			!nonempty(candidate.name) ||
			!candidate.facts
		)
			fail("Invalid or duplicate candidate");
		ids.add(candidate.id);
		for (const [name, value] of Object.entries(candidate.facts)) {
			if (!has(problem.attributes, name)) continue; // Unconsumed display facts do not affect decisions.
			if (
				!value ||
				!["known", "unknown", "not_applicable"].includes(value.state) ||
				!nonempty(value.source) ||
				!nonempty(value.version)
			)
				fail("Invalid fact state/provenance");
			if (
				value.state === "known"
					? !validValue(value.value, problem.attributes[name])
					: has(value, "value") && value.value !== null
			)
				fail("Fact state/value mismatch");
		}
	}
	if (problem.request === null || problem.request === undefined) return;
	const request = problem.request;
	if (
		!Array.isArray(request.conditions) ||
		!request.explicit_preferences ||
		request.explicit_preferences.version !== "2" ||
		!Array.isArray(request.explicit_preferences.terms)
	)
		fail("Missing explicit preference model");
	if (request.explicit_preferences.terms.length > 32)
		fail("At most 32 explicit terms are supported");
	const conditionIds = new Set();
	for (const condition of request.conditions) {
		if (!nonempty(condition.id) || conditionIds.has(condition.id))
			fail("Duplicate condition ID");
		validEnabled(condition);
		conditionIds.add(condition.id);
		validatePredicate(condition, problem.attributes, true);
		if (
			problem.attributes[condition.attribute].roles &&
			!problem.attributes[condition.attribute].roles.includes("hard")
		)
			fail("Attribute cannot be used as hard condition");
	}
	const termIds = new Set(),
		attributesUsed = new Set(),
		groupsUsed = new Set();
	for (const term of request.explicit_preferences.terms) {
		if (
			!term ||
			!nonempty(term.id) ||
			termIds.has(term.id) ||
			!finite(term.weight) ||
			term.weight < 0 ||
			term.weight > 1000000
		)
			fail("Invalid preference ID/weight");
		validEnabled(term);
		const common = [
			"id",
			"type",
			"weight",
			"enabled",
			"unknownUtility",
			"notApplicableUtility",
			"origin",
			"scope",
		];
		keysOnly(
			term,
			common.concat(
				term.type === "piecewise"
					? ["attribute", "unit", "knots"]
					: term.type === "match"
						? [
								"attribute",
								"unit",
								"op",
								"value",
								"trueUtility",
								"falseUtility",
							]
						: ["clauses", "trueUtility", "falseUtility"],
			),
		);
		termIds.add(term.id);
		for (const key of [
			"unknownUtility",
			"notApplicableUtility",
			"trueUtility",
			"falseUtility",
		])
			if (
				has(term, key) &&
				(!finite(term[key]) || term[key] < 0 || term[key] > 1)
			)
				fail("Invalid explicit fallback utility");
		let attributes;
		if (term.type === "piecewise") {
			if (
				!has(problem.attributes, term.attribute) ||
				problem.attributes[term.attribute].type !== "number" ||
				!Array.isArray(term.knots) ||
				term.knots.length < 2 ||
				term.knots.length > 32
			)
				fail("Invalid piecewise model");
			if (
				term.unit !== undefined &&
				term.unit !== problem.attributes[term.attribute].unit
			)
				fail("Preference unit mismatch");
			term.knots.forEach((pair, i) => {
				if (
					!Array.isArray(pair) ||
					pair.length !== 2 ||
					!pair.every(finite) ||
					pair[1] < 0 ||
					pair[1] > 1 ||
					(i > 0 && pair[0] <= term.knots[i - 1][0])
				)
					fail("Invalid knots");
			});
			attributes = [term.attribute];
		} else if (term.type === "match") {
			validatePredicate(term, problem.attributes, false);
			attributes = [term.attribute];
		} else if (term.type === "all_match") {
			if (
				!Array.isArray(term.clauses) ||
				term.clauses.length < 2 ||
				term.clauses.length > 8
			)
				fail("Invalid conjunction");
			term.clauses.forEach((clause) => {
				validateClause(clause, problem.attributes);
			});
			term.clauses.forEach((clause) => {
				keysOnly(clause, [
					"attribute",
					"op",
					"value",
					"lower",
					"upper",
					"unit",
				]);
			});
			attributes = term.clauses.map((clause) => clause.attribute);
			if (new Set(attributes).size !== attributes.length)
				fail("Conjunction repeats an attribute");
		} else fail("Unsupported preference term");
		for (const name of attributes)
			if (
				problem.attributes[name].roles &&
				!problem.attributes[name].roles.includes("soft")
			)
				fail("Attribute cannot be used as a preference");
		if (term.enabled === false || term.weight === 0) continue;
		for (const name of attributes) {
			const group = problem.attributes[name].semanticGroup;
			if (attributesUsed.has(name) || (group && groupsUsed.has(group)))
				fail("A preference attribute or semantic group is counted twice");
			attributesUsed.add(name);
			if (group) groupsUsed.add(group);
		}
	}
}
function evaluate(candidate, condition) {
	const value = fact(candidate, condition.attribute);
	return {
		attribute: condition.attribute,
		state: value.state,
		verdict:
			value.state === "known" && has(condition, "value")
				? predicate(value.value, condition.op, condition.value)
					? "satisfied"
					: "violated"
				: "insufficient",
	};
}
function conflicts(problem) {
	if (!problem.request) return [];
	const grouped = dictionary();
	for (const condition of enabled(problem.request.conditions).filter((item) =>
		has(item, "value"),
	)) {
		if (!grouped[condition.attribute]) grouped[condition.attribute] = [];
		grouped[condition.attribute].push(condition);
	}
	const result = [];
	for (const [name, conditions] of Object.entries(grouped)) {
		const attr = problem.attributes[name];
		let impossible = false;
		if (attr.type === "number") {
			let low = attr.minimum === undefined ? -Infinity : attr.minimum,
				high = attr.maximum === undefined ? Infinity : attr.maximum;
			for (const c of conditions) {
				if (["eq", "ge", "gte"].includes(c.op)) low = Math.max(low, c.value);
				if (["eq", "le", "lte"].includes(c.op)) high = Math.min(high, c.value);
			}
			const finiteSet = conditions.find((c) => c.op === "in");
			impossible =
				low > high ||
				(!!finiteSet &&
					!finiteSet.value.some((value) =>
						conditions.every((c) => predicate(value, c.op, c.value)),
					));
		} else if (attr.type === "string_set")
			impossible = conditions.some(
				(c) => c.op === "contains_any" && c.value.length === 0,
			);
		else {
			const possible =
				attr.type === "boolean"
					? [false, true]
					: attr.values ||
						conditions.flatMap((c) => (c.op === "in" ? c.value : [c.value]));
			impossible = !possible.some((value) =>
				conditions.every((c) => predicate(value, c.op, c.value)),
			);
		}
		if (impossible) result.push(name);
	}
	return result.sort();
}
function termValue(candidate, term) {
	const fallback = (key, defaultValue) =>
		Fraction.from(has(term, key) ? term[key] : defaultValue);
	if (term.type === "all_match") {
		const values = term.clauses.map((clause) => {
			const f = fact(candidate, clause.attribute);
			return f.state === "known" ? clauseValue(f.value, clause) : f.state;
		});
		if (values.includes(false))
			return { value: fallback("falseUtility", 0), state: "known" };
		if (values.includes("unknown"))
			return { value: fallback("unknownUtility", 0), state: "unknown" };
		if (values.includes("not_applicable"))
			return {
				value: fallback("notApplicableUtility", 0),
				state: "not_applicable",
			};
		return { value: fallback("trueUtility", 1), state: "known" };
	}
	const f = fact(candidate, term.attribute);
	if (f.state !== "known")
		return {
			value:
				f.state === "unknown"
					? fallback("unknownUtility", 0)
					: fallback("notApplicableUtility", 0),
			state: f.state,
		};
	if (term.type === "match")
		return {
			value: predicate(f.value, term.op, term.value)
				? fallback("trueUtility", 1)
				: fallback("falseUtility", 0),
			state: "known",
		};
	const x = Fraction.from(f.value),
		knots = term.knots;
	if (x.cmp(knots[0][0]) <= 0)
		return { value: Fraction.from(knots[0][1]), state: "known" };
	for (let i = 1; i < knots.length; i += 1) {
		if (x.cmp(knots[i][0]) <= 0) {
			const [x0, y0] = knots[i - 1],
				[x1, y1] = knots[i];
			return {
				value: Fraction.from(y0).add(
					x
						.sub(x0)
						.mul(Fraction.from(y1).sub(y0))
						.div(Fraction.from(x1).sub(x0)),
				),
				state: "known",
			};
		}
	}
	return { value: Fraction.from(knots[knots.length - 1][1]), state: "known" };
}
function utility(candidate, model) {
	let numerator = ZERO,
		denominator = ZERO;
	const terms = enabled(model.terms).map((term) => {
		const item = termValue(candidate, term),
			weight = Fraction.from(term.weight),
			contribution = item.value.mul(weight);
		numerator = numerator.add(contribution);
		denominator = denominator.add(weight);
		return {
			id: term.id,
			type: term.type,
			attributes:
				term.type === "all_match"
					? term.clauses.map((c) => c.attribute)
					: [term.attribute],
			state: item.state,
			value: item.value.toPair(),
			weight: weight.toPair(),
			contribution: contribution.toPair(),
		};
	});
	return {
		value: denominator.cmp(0) === 0 ? ZERO : numerator.div(denominator),
		weightSum: denominator,
		terms,
	};
}
function semanticSignature(problem, strategy, temperature) {
	const sortByContent = (items) =>
		items
			.slice()
			.sort((a, b) =>
				canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0,
			);
	const normalizePredicate = (item) => {
		const result = Object.assign({}, item);
		delete result.enabled;
		if (
			["in", "contains_any", "contains_all"].includes(result.op) &&
			has(result, "value")
		)
			result.value = sortByContent(result.value);
		return result;
	};
	const conditions = problem.request
		? sortByContent(enabled(problem.request.conditions).map(normalizePredicate))
		: [];
	const terms = problem.request
		? sortByContent(
				enabled(problem.request.explicit_preferences.terms).map((term) => {
					const result = normalizePredicate(term);
					result.unknownUtility = has(term, "unknownUtility")
						? term.unknownUtility
						: 0;
					result.notApplicableUtility = has(term, "notApplicableUtility")
						? term.notApplicableUtility
						: 0;
					if (term.type !== "piecewise") {
						result.trueUtility = has(term, "trueUtility")
							? term.trueUtility
							: 1;
						result.falseUtility = has(term, "falseUtility")
							? term.falseUtility
							: 0;
					}
					if (term.type === "all_match")
						result.clauses = sortByContent(
							term.clauses.map(normalizePredicate),
						);
					return result;
				}),
			)
		: [];
	const names = [
		...new Set(
			conditions
				.map((c) => c.attribute)
				.concat(
					terms.flatMap((t) =>
						t.type === "all_match"
							? t.clauses.map((c) => c.attribute)
							: [t.attribute],
					),
				),
		),
	].sort();
	return digest({
		requestPresent: !!problem.request,
		conditions,
		terms,
		attributes: names.map((name) => [name, problem.attributes[name]]),
		candidates: problem.candidates
			.map((c) => ({
				id: c.id,
				facts: names.map((name) => {
					const f = fact(c, name);
					return [
						name,
						f.state,
						f.state === "known"
							? problem.attributes[name].type === "string_set"
								? sortByContent(f.value)
								: f.value
							: null,
					];
				}),
			}))
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
		strategy,
		temperature,
	});
}
// A reproducible simulation PRNG, not a cryptographic or human sampling guarantee.
function seededWords(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (t ^ (t >>> 14)) >>> 0;
	};
}
function randomBelow(limit, word) {
	const bits = JSBI.subtract(limit, JSBI.BigInt(1)).toString(2).length;
	const words = Math.ceil(bits / 32),
		highBits = bits - (words - 1) * 32;
	for (let attempt = 0; attempt < 10000; attempt += 1) {
		let value = JSBI.BigInt(0);
		for (let i = 0; i < words; i += 1) {
			let part = word();
			if (!Number.isInteger(part) || part < 0 || part > 0xffffffff)
				fail("Invalid random word");
			if (i === 0 && highBits < 32) part = part % 2 ** highBits;
			value = JSBI.add(
				JSBI.leftShift(value, JSBI.BigInt(32)),
				JSBI.BigInt(part),
			);
		}
		if (JSBI.lessThan(value, limit)) return value;
	}
	fail("Random source failed rejection sampling");
}
function exactDistribution(scores, strategy, temperature) {
	const ids = Object.keys(scores).sort();
	if (!ids.length) return {};
	if (strategy === "explicit" || strategy === "greedy") {
		let best = ids[0];
		for (const id of ids) if (scores[id].cmp(scores[best]) > 0) best = id;
		return Object.fromEntries(ids.map((id) => [id, id === best ? ONE : ZERO]));
	}
	if (strategy === "uniform")
		return Object.fromEntries(ids.map((id) => [id, ONE.div(ids.length)]));
	const maximum = Math.max(...ids.map((id) => scores[id].toNumber()));
	const weights = ids.map((id) =>
		Math.exp((scores[id].toNumber() - maximum) / temperature),
	);
	if (weights.some((weight) => weight === 0))
		fail("Softmax underflow; increase temperature");
	// Compensated sum then preserve and normalize the resulting binary64 ratios.
	let total = 0,
		correction = 0;
	for (const value of weights) {
		const y = value - correction,
			t = total + y;
		correction = t - total - y;
		total = t;
	}
	const probabilities = weights.map((value) => value / total);
	if (probabilities.some((value) => value === 0))
		fail("Probability underflow; increase temperature");
	const rational = probabilities.map(Fraction.from),
		sum = rational.reduce((acc, value) => acc.add(value), ZERO);
	return Object.fromEntries(ids.map((id, i) => [id, rational[i].div(sum)]));
}
function sample(distribution, word) {
	const entries = Object.entries(distribution).filter(
		([, value]) => value.cmp(0) > 0,
	);
	if (!entries.length) fail("Empty probability support");
	// General LCM, so uniform distributions and tiny binary64 masses both remain exact.
	let denominator = JSBI.BigInt(1);
	for (const [, value] of entries) {
		const d = JSBI.BigInt(value.toPair()[1]);
		let a = denominator,
			b = d;
		while (!JSBI.equal(b, JSBI.BigInt(0))) {
			const r = JSBI.remainder(a, b);
			a = b;
			b = r;
		}
		denominator = JSBI.multiply(JSBI.divide(denominator, a), d);
	}
	const masses = entries.map(([id, value]) => {
		const pair = value.toPair();
		return [
			id,
			JSBI.multiply(
				JSBI.BigInt(pair[0]),
				JSBI.divide(denominator, JSBI.BigInt(pair[1])),
			),
		];
	});
	const total = masses.reduce(
		(sum, [, mass]) => JSBI.add(sum, mass),
		JSBI.BigInt(0),
	);
	const draw = randomBelow(total, word);
	let cumulative = JSBI.BigInt(0);
	for (const [id, mass] of masses) {
		cumulative = JSBI.add(cumulative, mass);
		if (JSBI.lessThan(draw, cumulative)) return id;
	}
	fail("Invalid sampler state");
}
function createSession(seed) {
	if (!Number.isInteger(seed)) fail("Seed must be an integer");
	return { seed, seen: new Set(), signature: null, word: seededWords(seed) };
}
function decide(problem, session, strategy = "explicit", temperature = 1) {
	validate(problem);
	if (
		!["explicit", "greedy", "uniform", "weighted"].includes(strategy) ||
		!finite(temperature) ||
		temperature <= 0
	)
		fail("Invalid strategy or temperature");
	const signature = semanticSignature(problem, strategy, temperature);
	if (session.signature !== null && session.signature !== signature)
		fail("Decision semantics changed; reset session");
	const request = problem.request,
		missing = request
			? enabled(request.conditions)
					.filter((c) => !has(c, "value"))
					.map((c) => c.attribute)
			: ["request"];
	const contradictions = conflicts(problem),
		feasible = [],
		unknown = [],
		rejected = [],
		constraints = dictionary(),
		utilities = dictionary(),
		scores = dictionary();
	for (const candidate of problem.candidates) {
		const traces = request
			? enabled(request.conditions).map((c) => evaluate(candidate, c))
			: [];
		constraints[candidate.id] = traces;
		if (
			!request ||
			contradictions.length ||
			traces.some((t) => t.verdict === "violated")
		)
			rejected.push(candidate.id);
		else if (traces.some((t) => t.verdict === "insufficient"))
			unknown.push(candidate.id);
		else {
			feasible.push(candidate.id);
			const u = utility(candidate, request.explicit_preferences);
			scores[candidate.id] = u.value;
			utilities[candidate.id] = {
				score: u.value.toPair(),
				weightSum: u.weightSum.toPair(),
				terms: u.terms,
			};
		}
	}
	feasible.sort();
	unknown.sort();
	rejected.sort();
	const remaining = feasible.filter((id) => !session.seen.has(id));
	let status,
		selectedId = null,
		probabilities = {};
	if (missing.length) status = "missing_input";
	else if (contradictions.length) status = "no_feasible_candidate";
	else if (remaining.length) {
		probabilities = exactDistribution(
			Object.fromEntries(remaining.map((id) => [id, scores[id]])),
			strategy,
			temperature,
		);
		selectedId = ["explicit", "greedy"].includes(strategy)
			? remaining.find((id) => probabilities[id].cmp(1) === 0)
			: sample(probabilities, session.word);
		status = "recommended";
	} else if (unknown.length) status = "needs_information";
	else if (feasible.length) status = "exhausted";
	else status = "no_feasible_candidate";
	const result = {
		status,
		selectedId,
		feasible,
		unknown,
		rejected,
		remaining,
		missing,
		contradictions,
		constraints,
		utilities,
		probabilities: Object.fromEntries(
			Object.entries(probabilities).map(([id, value]) => [id, value.toPair()]),
		),
		seenBefore: [...session.seen].sort(),
		signature,
		strategy,
		temperature,
	};
	session.signature = signature;
	if (selectedId !== null) session.seen.add(selectedId);
	return result;
}
module.exports = {
	validate,
	decide,
	createSession,
	semanticSignature,
	utility,
	evaluate,
	conflicts,
	exactDistribution,
	sample,
	randomBelow,
	seededWords,
};
