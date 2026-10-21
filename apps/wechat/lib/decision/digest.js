// biome-ignore lint/suspicious/noRedundantUseStrict: WeChat executes CommonJS wrappers, not ES modules.
"use strict";

// Content binding only: a hash does not authenticate a person, a source or a fact.
function canonical(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value))
		return JSON.stringify(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1)
			// biome-ignore lint/suspicious/noPrototypeBuiltins: Do not require ES2022 Object.hasOwn in WeChat.
			if (!Object.prototype.hasOwnProperty.call(value, i))
				throw new TypeError("Sparse arrays cannot be bound");
		return `[${value.map(canonical).join(",")}]`;
	}
	if (
		value &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	) {
		return (
			"{" +
			Object.keys(value)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
				.join(",") +
			"}"
		);
	}
	throw new TypeError("Only finite JSON values may be bound");
}

function utf8(text) {
	const bytes = [];
	for (let i = 0; i < text.length; i += 1) {
		let code = text.charCodeAt(i);
		if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			i + 1 < text.length &&
			text.charCodeAt(i + 1) >= 0xdc00 &&
			text.charCodeAt(i + 1) <= 0xdfff
		) {
			code = 0x10000 + ((code - 0xd800) << 10) + text.charCodeAt(++i) - 0xdc00;
		} else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
		if (code < 128) bytes.push(code);
		else if (code < 2048) bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 63));
		else if (code < 65536)
			bytes.push(
				0xe0 | (code >>> 12),
				0x80 | ((code >>> 6) & 63),
				0x80 | (code & 63),
			);
		else
			bytes.push(
				0xf0 | (code >>> 18),
				0x80 | ((code >>> 12) & 63),
				0x80 | ((code >>> 6) & 63),
				0x80 | (code & 63),
			);
	}
	return bytes;
}

function sha256(text) {
	const bytes = utf8(text);
	const length = bytes.length;
	bytes.push(128);
	while (bytes.length % 64 !== 56) bytes.push(0);
	const high = Math.floor(length / 0x20000000),
		low = (length * 8) >>> 0;
	for (let n = 24; n >= 0; n -= 8) bytes.push((high >>> n) & 255);
	for (let n = 24; n >= 0; n -= 8) bytes.push((low >>> n) & 255);
	const h = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	];
	const k = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
		0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
		0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
		0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
		0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
		0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
		0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
		0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
		0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
	for (let offset = 0; offset < bytes.length; offset += 64) {
		const w = new Array(64);
		for (let i = 0; i < 16; i += 1)
			w[i] =
				((bytes[offset + 4 * i] << 24) |
					(bytes[offset + 4 * i + 1] << 16) |
					(bytes[offset + 4 * i + 2] << 8) |
					bytes[offset + 4 * i + 3]) >>>
				0;
		for (let i = 16; i < 64; i += 1) {
			const a = w[i - 15],
				b = w[i - 2];
			w[i] =
				(w[i - 16] +
					(rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
					w[i - 7] +
					(rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>>
				0;
		}
		let [a, b, c, d, e, f, g, j] = h;
		for (let i = 0; i < 64; i += 1) {
			const t1 =
				(j +
					(rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
					((e & f) ^ (~e & g)) +
					k[i] +
					w[i]) >>>
				0;
			const t2 =
				((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
					((a & b) ^ (a & c) ^ (b & c))) >>>
				0;
			j = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		[a, b, c, d, e, f, g, j].forEach((value, i) => {
			h[i] = (h[i] + value) >>> 0;
		});
	}
	return h.map((value) => (`00000000${value.toString(16)}`).slice(-8)).join("");
}

function digest(value) {
	return sha256(canonical(value));
}
function clone(value) {
	return JSON.parse(canonical(value));
}
function freeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.keys(value).forEach((key) => {
			freeze(value[key]);
		});
		Object.freeze(value);
	}
	return value;
}
module.exports = { canonical, sha256, digest, clone, freeze };
