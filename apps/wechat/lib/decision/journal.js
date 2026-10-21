// biome-ignore lint/suspicious/noRedundantUseStrict: WeChat executes CommonJS wrappers, not ES modules.
"use strict";
const { canonical, clone, digest, freeze } = require("./digest");

// R9 event meanings in a bounded, memory-only journal. This is not a training set.
// No participant identity, remote ingestion, implicit preference labels or disk IO.
function createJournal(source = "interaction") {
	if (!["interaction", "qa"].includes(source))
		throw new TypeError("Unknown event source");
	const events = [],
		keys = new Map(),
		presentations = new Map(),
		revoked = new Set();
	let epoch = 1,
		activePresentationId = null;
	function reject(message) {
		const error = new Error(message);
		error.code = "STALE_DECISION_EVENT";
		throw error;
	}
	function append(key, type, payload) {
		if (typeof key !== "string" || !key) reject("An event key is required");
		const body = canonical({ type, payload }),
			scope = `${epoch}:${key}`;
		if (keys.has(scope)) {
			const previous = keys.get(scope);
			if (previous.body !== body) reject("Conflicting event retry");
			return previous.event;
		}
		if (events.length >= 5000)
			reject("Session event capacity reached; start a new session");
		const event = freeze({
			id: `event-${events.length + 1}`,
			epoch,
			source,
			intent: "virtual_decision",
			type,
			payload: clone(payload),
			sequence: events.length + 1,
			researchEligible: false,
			previousDigest: events.length ? digest(events[events.length - 1]) : null,
		});
		events.push(event);
		keys.set(scope, { body, event });
		return event;
	}
	function bound(binding) {
		const item = presentations.get(binding?.presentationId);
		if (
			!item ||
			item.epoch !== epoch ||
			binding.presentationId !== activePresentationId ||
			canonical(item.binding) !== canonical(binding)
		)
			reject("Presentation is no longer current");
		return item;
	}
	function prepare(key, snapshot) {
		const content = clone(snapshot);
		if (!content.candidateId || !Number.isSafeInteger(content.revision))
			reject("Invalid presentation");
		const presentationId = `presentation-${digest({ epoch, content })}`;
		const binding = freeze({
			presentationId,
			candidateId: content.candidateId,
			revision: content.revision,
			contentDigest: digest(content),
		});
		const event = append(key, "prepared", { binding, snapshot: content });
		if (!presentations.has(presentationId)) {
			presentations.set(presentationId, {
				epoch,
				binding,
				rendered: false,
				choiceId: null,
			});
			activePresentationId = presentationId;
		}
		return { binding, event };
	}
	function rendered(key, binding) {
		const item = bound(binding);
		const event = append(key, "client_reported_rendered", {
			binding,
			meaning: "client_reported_rendered_not_verified_viewed",
		});
		item.rendered = true;
		return event;
	}
	function choose(key, binding) {
		const item = bound(binding);
		if (!item.rendered) reject("The current card has not reported rendering");
		const scope = `${epoch}:${key}`;
		const retry = keys.has(scope);
		if (item.choiceId && !revoked.has(item.choiceId) && !retry)
			reject("An active choice already exists for this card");
		const event = append(key, "choose", {
			binding,
			meaning: "selected_this_virtual_option_only",
		});
		// A retry of an older, revoked choice must not replace a newer active one.
		if (!retry) item.choiceId = event.id;
		return event;
	}
	function reroll(key, binding) {
		bound(binding);
		return append(key, "reroll", {
			binding,
			meaning: "requested_another_option_not_pairwise_preference",
		});
	}
	function revoke(key, eventId) {
		const target = events.find((event) => event.id === eventId);
		if (target?.type !== "choose" || target.source !== source)
			reject("No revocable choice exists");
		const event = append(key, "revoke", {
			targetId: eventId,
			targetEpoch: target.epoch,
		});
		revoked.add(eventId);
		return event;
	}
	function nextEpoch(reason) {
		append("close-epoch", "context_closed", { reason });
		epoch += 1;
		return epoch;
	}
	function exportState() {
		return clone({
			version: "virtual-decision-events-v1",
			source,
			intent: "virtual_decision",
			memoryOnly: true,
			researchEligible: false,
			epoch,
			events,
			activeChoiceIds: events
				.filter((e) => e.type === "choose" && !revoked.has(e.id))
				.map((e) => e.id),
		});
	}
	return { prepare, rendered, choose, reroll, revoke, nextEpoch, exportState };
}
module.exports = { createJournal };
