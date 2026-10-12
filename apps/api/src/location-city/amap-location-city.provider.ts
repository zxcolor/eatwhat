import type { PlaceSearchCoordinate } from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { applyAmapWebServiceSignature } from "../providers/amap-request-signature.js";
import { classifyAmapResponseStatus } from "../providers/amap-response-status.js";
import { toGcj02 } from "../recommendations/domain/geo.js";

export const AMAP_LOCATION_CITY_FETCH = Symbol("AMAP_LOCATION_CITY_FETCH");
export const AMAP_LOCATION_CITY_RESPONSE_MAX_BYTES = 64 * 1_024;

class CityProviderUnavailableError extends Error {
	constructor() { super("LOCATION_CITY_PROVIDER_UNAVAILABLE"); }
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown> : null;
}

function cityString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const controls = [...trimmed].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
	return trimmed.length > 0 && trimmed.length <= 80 && !controls
		? trimmed : null;
}

function parseCity(raw: unknown): string | null {
	const body = objectValue(raw);
	if (body === null || classifyAmapResponseStatus(body.status, body.infocode).classification !== "SUCCESS") {
		throw new CityProviderUnavailableError();
	}
	const address = objectValue(objectValue(body.regeocode)?.addressComponent);
	if (address === null) throw new CityProviderUnavailableError();
	const city = cityString(address.city);
	if (city !== null) return city;
	// AMap documents an empty city for the four province-level municipalities.
	const province = cityString(address.province);
	return province !== null && ["北京市", "上海市", "天津市", "重庆市"].includes(province) ? province : null;
}

async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
	if (signal.aborted) throw new CityProviderUnavailableError();
	return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
		const onAbort = () => reject(new CityProviderUnavailableError());
		signal.addEventListener("abort", onAbort, { once: true });
		reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const declaredLength = response.headers.get("content-length")?.trim();
	if (declaredLength !== undefined && /^\d+$/u.test(declaredLength) &&
		(!Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > AMAP_LOCATION_CITY_RESPONSE_MAX_BYTES)) {
		void response.body?.cancel().catch(() => undefined);
		throw new CityProviderUnavailableError();
	}
	if (response.body === null) throw new CityProviderUnavailableError();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const result = await readWithAbort(reader, signal);
			if (result.done) break;
			total += result.value.byteLength;
			if (total > AMAP_LOCATION_CITY_RESPONSE_MAX_BYTES) throw new CityProviderUnavailableError();
			chunks.push(result.value);
		}
	} catch {
		void reader.cancel().catch(() => undefined);
		throw new CityProviderUnavailableError();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

@Injectable()
export class AmapLocationCityProvider {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(AMAP_LOCATION_CITY_FETCH) private readonly fetchImpl: typeof fetch,
	) {}

	async city(location: PlaceSearchCoordinate): Promise<string | null> {
		if (!this.config.amap.enabled || this.config.amap.apiKey === null) throw new CityProviderUnavailableError();
		const origin = toGcj02(location);
		const endpoint = new URL("https://restapi.amap.com/v3/geocode/regeo");
		endpoint.searchParams.set("key", this.config.amap.apiKey);
		endpoint.searchParams.set("location", `${origin.longitude.toFixed(6)},${origin.latitude.toFixed(6)}`);
		endpoint.searchParams.set("extensions", "base");
		endpoint.searchParams.set("radius", "0");
		endpoint.searchParams.set("output", "json");
		applyAmapWebServiceSignature(endpoint, this.config.amap.signingPrivateKey);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.amap.timeoutMs);
		try {
			// Only the fixed, official provider URL carries coordinates. Do not log,
			// cache or return it; the public response contains only the city name.
			const response = await this.fetchImpl(endpoint, {
				method: "GET", headers: { Accept: "application/json" }, signal: controller.signal,
				cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
			});
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				throw new CityProviderUnavailableError();
			}
			return parseCity(await readBoundedJson(response, controller.signal));
		} catch { throw new CityProviderUnavailableError(); }
		finally { clearTimeout(timeout); }
	}
}
