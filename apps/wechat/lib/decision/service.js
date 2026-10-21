// biome-ignore lint/suspicious/noRedundantUseStrict: WeChat executes CommonJS wrappers, not ES modules.
"use strict";
const catalog = require("./catalog");
const core = require("./core");
const research = require("./research");
const { createJournal } = require("./journal");
const { clone, digest, freeze } = require("./digest");

const ENGINE_VERSION = "wechat-research-decision-v2";
const DEFAULTS = freeze({
	mode: "VIRTUAL",
	target: "PACKAGE",
	origin: { x: 500, y: 500, label: "虚拟广场" },
	options: {
		budgetCents: null,
		maxDistanceUnits: null,
		vegetarianOnly: false,
		maxSpicy: null,
		preferMain: true,
		weights: { price: 1, distance: 1, main: 1 },
		taste: null,
	},
	strategy: "explicit",
});
function createService(dependencies = {}) {
	const data = dependencies.catalog || catalog;
	const seed =
		dependencies.seed === undefined
			? Date.now() % 0x100000000
			: dependencies.seed;
	let session = core.createSession(seed),
		journal = createJournal(dependencies.source || "interaction");
	let config = clone(DEFAULTS),
		problem = null,
		inputDigest = null,
		last = null,
		binding = null,
		revision = 0,
		choiceAttempt = 0;
	let profile = null;
	let updatingProfile = false;
	let state = {
		...clone(DEFAULTS),
		status: "idle",
		current: null,
		revision,
		summary: "从完整虚拟目录直接决定一份",
		reasons: [],
		uncertainties: [],
		counts: { total: 0, feasible: 0, unknown: 0, rejected: 0, remaining: 0 },
		receipt: null,
		research: {
			learningEnabled: false,
			activeQuestionsEnabled: false,
			evidenceStatus: "evidence_insufficient",
			scope: "virtual_configuration_only",
		},
	};
	function invalid(message) {
		const error = new Error(message);
		error.code = "INVALID_DECISION_INPUT";
		throw error;
	}
	function build(settings) {
		const result = data.buildProblem({
			target: settings.target,
			origin: { x: settings.origin.x, y: settings.origin.y },
			...settings.options,
		});
		core.validate(result);
		return result;
	}
	function getState() {
		if (dependencies.requireProfile && profile && !profileAvailable()) {
			profile = null;
			reset();
		}
		return freeze(clone({ ...state, profileReady: profileAvailable() }));
	}
	function profileAvailable() {
		return !dependencies.requireProfile || (!!profile && (!dependencies.canUseProfile || dependencies.canUseProfile()));
	}
	function requireProfile() {
		getState();
		if (!profileAvailable()) {
			const error = new Error("请先完成并确认口味偏好");
			error.code = "PREFERENCES_REQUIRED";
			throw error;
		}
	}
	function setProfile(answers) {
		const compiled = answers === null ? null : require("./taste-profile").compile(answers);
		if (answers !== null && profile && digest(profile) === digest(answers) && profileAvailable()) return getState();
		const previous = profile;
		updatingProfile = true;
		try {
			if (compiled) {
				profile = clone(answers);
				configure({ options: { ...clone(DEFAULTS.options), ...compiled }, strategy: "explicit" });
			} else {
				profile = null;
				reset();
			}
		} catch (error) { profile = previous; throw error; }
		finally { updatingProfile = false; }
		return getState();
	}
	function configure(patch = {}) {
		if (
			!patch ||
			typeof patch !== "object" ||
			Array.isArray(patch) ||
			Object.keys(patch).some(
				(key) => !["target", "origin", "options", "strategy"].includes(key),
			)
		)
			invalid("不支持的决定设置");
		if (
			patch.options !== undefined &&
			(!patch.options ||
				typeof patch.options !== "object" ||
				Array.isArray(patch.options) ||
				Object.keys(patch.options).some(key => !Object.keys(DEFAULTS.options).includes(key)))
		)
			invalid("条件格式错误");
		if (profile && !updatingProfile && patch.options &&
			// biome-ignore lint/suspicious/noPrototypeBuiltins: Do not require ES2022 Object.hasOwn in WeChat.
			Object.prototype.hasOwnProperty.call(patch.options, "taste") &&
			digest(patch.options.taste) !== digest(config.options.taste))
			invalid("请在口味偏好页面修改喜欢或避开的类型");
		if (
			patch.options &&
			// biome-ignore lint/suspicious/noPrototypeBuiltins: Do not require ES2022 Object.hasOwn in WeChat.
			Object.prototype.hasOwnProperty.call(patch.options, "weights") &&
			(!patch.options.weights ||
				typeof patch.options.weights !== "object" ||
				Array.isArray(patch.options.weights))
		)
			invalid("偏好权重格式错误");
		if (
			patch.origin !== undefined &&
			(!patch.origin ||
				typeof patch.origin !== "object" ||
				Array.isArray(patch.origin) ||
				Object.keys(patch.origin).some(
					(key) => !["x", "y", "label"].includes(key),
				))
		)
			invalid("虚拟地点格式错误");
		const next = {
			...config,
			...patch,
			origin: { ...config.origin, ...patch.origin },
			options: {
				...config.options,
				...patch.options,
				weights: {
					...config.options.weights,
					...(patch.options?.weights),
				},
			},
		};
		if (!["explicit", "uniform", "weighted"].includes(next.strategy))
			invalid("不支持的决定方式");
		if (
			typeof next.origin.label !== "string" ||
			!next.origin.label ||
			next.origin.label.length > 60
		)
			invalid("虚拟地点名称无效");
		const nextProblem = build(next),
			nextSignature = core.semanticSignature(nextProblem, next.strategy, 1),
			nextInputDigest = digest(nextProblem);
		const previousSignature = problem
			? core.semanticSignature(problem, config.strategy, 1)
			: null;
		const contentChanged =
			inputDigest !== nextInputDigest ||
			config.origin.label !== next.origin.label;
		// A display/source revision invalidates confirmation even when scoring is
		// unchanged. Preserve the seen set and refresh the same card in that case.
		const refreshed =
			previousSignature === nextSignature && contentChanged && state.current
				? makeCard(state.current.id, next, nextProblem, revision + 1)
				: null;
		if (previousSignature !== nextSignature) {
			journal.nextEpoch("decision_semantics_changed");
			session = core.createSession(seed);
			revision += 1;
			last = null;
			binding = null;
			state = {
				...state,
				status: "idle",
				current: null,
				receipt: null,
				revision,
				reasons: [],
				uncertainties: [],
				summary: "条件已更新，重新为你决定",
				counts: {
					total: nextProblem.candidates.length,
					feasible: 0,
					unknown: 0,
					rejected: 0,
					remaining: 0,
				},
			};
		} else if (contentChanged) {
			journal.nextEpoch("presentation_content_changed");
			revision += 1;
			binding = null;
			choiceAttempt = 0;
			state = {
				...state,
				current: refreshed,
				receipt: null,
				revision,
				status: refreshed ? "recommended" : state.status,
				summary: refreshed ? "展示资料已更新，请重新确认" : state.summary,
				reasons: refreshed ? refreshed.reasons : [],
				uncertainties: refreshed ? refreshed.uncertainties : [],
			};
		}
		config = clone(next);
		problem = nextProblem;
		inputDigest = nextInputDigest;
		state = { ...state, ...clone(config) };
		if (refreshed) prepareCard(refreshed, last);
		return getState();
	}
	function ensureProblem() {
		if (!problem) {
			problem = build(config);
			inputDigest = digest(problem);
		}
	}
	function makeCard(
		id,
		settings = config,
		currentProblem = problem,
		currentRevision = revision,
	) {
		const display = data.getDisplay(id, settings.target, currentProblem);
		if (!display) invalid("缺少当前虚拟候选的展示信息");
		const role = { main: "模拟正餐", snack: "模拟小食", drink: "模拟饮品" };
		const priceText =
			display.priceCents === null
				? "虚拟价格未知"
				: `¥${(display.priceCents / 100).toFixed(2)}`;
		const factsSummary = [
			display.priceLabel,
			display.storeCategory
				? `店铺主分类：${display.storeCategory}`
				: "店铺主分类未知",
		];
		if (display.vegetarian !== null)
			factsSummary.push(
				display.vegetarian ? "模拟素食属性：是" : "模拟素食属性：否",
			);
		if (display.spicy !== null)
			factsSummary.push(`模拟辣度：${display.spicy}/3`);
		const reasons = [];
		if (settings.options.taste) {
			const preferences = require("./taste-profile");
			const group = preferences.GROUPS.find(item => item.categories.includes(display.storeCategory));
			if (group && settings.options.taste.likedGroups.includes(group.id)) reasons.push(`属于你喜欢的${group.label}类型`);
			if (settings.options.taste.avoidedGroups.length) reasons.push("已排除你选择避开的餐厅类型");
		}
		if (settings.options.budgetCents !== null) reasons.push("符合本次虚拟预算");
		if (settings.options.maxDistanceUnits !== null)
			reasons.push("在本次虚拟距离内");
		if (settings.options.vegetarianOnly) reasons.push("有明确的模拟素食属性");
		if (settings.options.maxSpicy !== null) reasons.push("模拟辣度符合要求");
		if (settings.target === "RESTAURANT")
			reasons.push("由同一份套餐满足全部硬条件");
		reasons.push(
			settings.strategy === "explicit"
				? "在未展示且满足硬条件的选项中，按你的偏好得分最高"
				: settings.strategy === "uniform"
					? "从未展示且满足硬条件的选项中随机抽取"
					: "按偏好分配抽取权重，本次换个口味",
		);
		const uncertainties = ["具体配料、分量和营养未知"];
		if (display.vegetarian === null) uncertainties.push("模拟素食属性未知");
		if (display.spicy === null) uncertainties.push("模拟辣度未知");
		return {
			...display,
			id,
			name: display.name,
			restaurantName: display.restaurantName,
			mealName: display.mealName,
			priceText,
			distanceText: `${Math.round(display.distanceUnits)} 虚拟距离单位`,
			roleText: role[display.mealRole] || "模拟用餐类型未知",
			factsSummary,
			reasons,
			uncertainties,
			mode: "VIRTUAL",
			target: settings.target,
			revision: currentRevision,
			disclosure: "虚拟场景数据；不是现实地址、当前售价或可购买承诺。",
			scoreMeaning: "配置偏好得分，不是满意度概率",
		};
	}
	function prepareCard(current, result) {
		const candidate = problem.candidates.find((item) => item.id === current.id);
		const prepared = journal.prepare(`prepare-${revision}`, {
			candidateId: current.id,
			revision,
			engineVersion: ENGINE_VERSION,
			inputDigest,
			semanticDigest: result.signature,
			dataset: problem.dataset,
			context: problem.context,
			request: problem.request,
			facts: candidate.facts,
			display: current,
			strategy: config.strategy,
			utility: result.utilities[current.id],
			probability: result.probabilities[current.id],
		});
		binding = prepared.binding;
	}
	function recommend(options = {}) {
		requireProfile();
		if (
			!options ||
			typeof options !== "object" ||
			Array.isArray(options) ||
			Object.keys(options).some((key) => key !== "reroll") ||
			(options.reroll !== undefined && typeof options.reroll !== "boolean")
		)
			invalid("推荐操作格式错误");
		ensureProblem();
		if (state.current && !options.reroll) return getState();
		if (options.reroll && binding)
			journal.reroll(`reroll-${revision}`, binding);
		const next = core.decide(problem, session, config.strategy, 1);
		revision += 1;
		last = next;
		binding = null;
		choiceAttempt = 0;
		const current = next.selectedId === null ? null : makeCard(next.selectedId);
		if (current) prepareCard(current, next);
		const summary =
			next.status === "recommended"
				? "这顿就吃这个"
				: next.status === "exhausted"
					? "符合条件的选项已换完"
					: next.status === "needs_information" ||
							next.status === "missing_input"
						? "还缺少足以确认的资料"
						: "没有满足全部条件的选项";
		state = {
			...state,
			status:
				next.status === "missing_input" ? "needs_information" : next.status,
			current,
			revision,
			summary,
			reasons: current ? current.reasons : [],
			uncertainties: current ? current.uncertainties : [],
			receipt: null,
			counts: {
				total: problem.candidates.length,
				feasible: next.feasible.length,
				unknown: next.unknown.length,
				rejected: next.rejected.length,
				remaining: Math.max(0, next.remaining.length - (current ? 1 : 0)),
			},
		};
		return getState();
	}
	function resolve(candidateId, requestedRevision) {
		getState();
		if (!profileAvailable()) return null;
		if (
			!state.current ||
			state.current.id !== candidateId ||
			revision !== requestedRevision
		)
			return null;
		return freeze(clone(state.current));
	}
	// A read-only browse snapshot: never draws RNG, marks a view, or consumes a
	// recommendation. Preview cards cannot be confirmed through resolve().
	function previewCandidates(limit = 3) {
		requireProfile();
		if (!Number.isInteger(limit) || limit < 0 || limit > 6) invalid("预览数量无效");
		ensureProblem();
		const conditions = problem.request.conditions.filter(item => item.enabled !== false);
		const counts = { total: problem.candidates.length, feasible: 0, unknown: 0, rejected: 0 };
		const available = [];
		for (const candidate of problem.candidates) {
			const traces = conditions.map(condition => core.evaluate(candidate, condition));
			if (traces.some(trace => trace.verdict === "violated")) counts.rejected += 1;
			else if (traces.some(trace => trace.verdict === "insufficient")) counts.unknown += 1;
			else {
				counts.feasible += 1;
				if (!session.seen.has(candidate.id)) available.push(candidate);
			}
		}
		// Preview is catalog browsing, not an unrecorded recommendation or a
		// prediction of a random draw. Keep its stable source order explicit.
		const cards = available.slice(0, limit).map(candidate => {
			const value = makeCard(candidate.id);
			return { ...value, preview: true, reasons: ["符合当前筛选条件，尚未作出推荐"], openingText: "营业状态未知" };
		});
		return freeze(clone({ cards, counts, remaining: available.length }));
	}
	function requireCurrent(value) {
		if (!value || !resolve(value.candidateId, value.revision) || !binding) {
			const error = new Error("这份决定已更新，请返回当前结果");
			error.code = "STALE_DECISION_EVENT";
			throw error;
		}
	}
	function markRendered(value) {
		requireCurrent(value);
		journal.rendered(`rendered-${revision}`, binding);
		return getState();
	}
	function confirm(value) {
		requireCurrent(value);
		const event = journal.choose(
			`choose-${revision}-${choiceAttempt}`,
			binding,
		);
		state = {
			...state,
			status: "confirmed",
			summary: "这次就选它",
			receipt: {
				eventId: event.id,
				candidateId: state.current.id,
				revision,
				meaning: "本次虚拟选择；不代表已购买、吃过或优于其他套餐",
			},
		};
		return getState();
	}
	function revokeReceipt() {
		if (!state.receipt) return getState();
		journal.revoke(`revoke-${state.receipt.eventId}`, state.receipt.eventId);
		choiceAttempt += 1;
		state = {
			...state,
			status: "recommended",
			summary: "已撤销本次选择",
			receipt: null,
		};
		return getState();
	}
	function reset() {
		session = core.createSession(seed);
		journal = createJournal(dependencies.source || "interaction");
		config = clone(DEFAULTS);
		if (profile) config.options = { ...config.options, ...require("./taste-profile").compile(profile) };
		problem = null;
		inputDigest = null;
		last = null;
		binding = null;
		revision += 1;
		state = {
			...state,
			...clone(config),
			status: "idle",
			current: null,
			revision,
			receipt: null,
			reasons: [],
			uncertainties: [],
			summary: "从完整虚拟目录直接决定一份",
			counts: { total: 0, feasible: 0, unknown: 0, rejected: 0, remaining: 0 },
		};
		return getState();
	}
	function getDiagnostics() {
		getState();
		// R4-R8 are kept as exact, independently tested public-table math. With no
		// independent p/d/c evidence and no pairwise UI, the application buys no
		// signal, publishes no question and never switches on inferred feedback.
		const evidence = research.evidenceBounds(null, { binding: inputDigest });
		return freeze(
			clone({
				engineVersion: ENGINE_VERSION,
				mode: "VIRTUAL",
				catalog: data.manifest,
				inputDigest,
				semanticDigest: last ? last.signature : null,
				strategy: config.strategy,
				declaredPreferences: {
					available: !!profile && profileAvailable(),
					source: profile ? "explicit_user_declarations" : null,
					meaning: "Configuration preferences; not learned satisfaction or independent evidence.",
				},
				selection: last
					? {
							id: last.selectedId,
							utility: last.selectedId ? last.utilities[last.selectedId] : null,
							probability: last.selectedId
								? last.probabilities[last.selectedId]
								: null,
						}
					: null,
				evidence,
				policy: {
					default: "explicit",
					activeQuestionsEnabled: false,
					signalAcquisitions: 0,
					questionsPublished: 0,
					paidCost: ["0", "1"],
					learningEnabled: false,
					reason:
						"No independent utility-strength, fixed-policy switch-probability or same-scale burden evidence; single choices are not pairwise answers.",
				},
				events: journal.exportState(),
			}),
		);
	}
	return {
		getState,
		configure,
		setProfile,
		recommend,
		confirm,
		markRendered,
		resolve,
		previewCandidates,
		reset,
		revokeReceipt,
		getDiagnostics,
	};
}
module.exports = {
	...createService({ requireProfile: true, canUseProfile: () => require("../taste-profile").isReady() }),
	createService,
	ENGINE_VERSION,
};
