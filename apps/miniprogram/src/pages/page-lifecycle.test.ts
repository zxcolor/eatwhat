import { afterEach, describe, expect, it, vi } from "vitest";

interface TestPage {
	data: Record<string, unknown>;
	setData(patch: Record<string, unknown>): void;
	onShow(): void;
	onHide(): void;
	onRequestCode(): Promise<void>;
	onSubmit(): Promise<void>;
	onDownloadExport(): Promise<void>;
	onTakeExport(): Promise<void>;
	onMethodChange(event: {
		currentTarget: { dataset: { method: string } };
	}): void;
	onPhoneInput(event: { detail: { value: string } }): void;
	currentChallengeScope(): string | null;
	loadAccount(): Promise<void>;
	phoneInput: string;
	emailInput: string;
	otpInput: string;
	challengeId: string | null;
	[key: string]: unknown;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function loadPage(
	kind: "login" | "account",
	auth: Record<string, unknown>,
) {
	vi.resetModules();
	let options: Record<string, unknown> = {};
	const unlink = vi.fn();
	const runtime = {
		reLaunch: vi.fn(),
		showToast: vi.fn(),
		hideShareMenu: vi.fn(),
		showModal: vi.fn((options) => options.success({ confirm: true })),
		shareFileMessage: vi.fn(),
		getFileSystemManager: () => ({ unlinkSync: unlink }),
		unlink,
	};
	vi.stubGlobal("wx", runtime);
	vi.stubGlobal("Page", (value: Record<string, unknown>) => {
		options = value;
	});
	vi.stubGlobal("getApp", () => ({
		globalData: {
			preferences: { theme: () => "LIGHT" },
			consent: { isAllowed: () => true },
			auth,
		},
	}));
	if (kind === "login") await import("./login/index");
	else await import("./account/index");
	const page = {
		...options,
		data: { ...(options.data as object) },
		setData(patch: Record<string, unknown>) {
			Object.assign(this.data, patch);
		},
	} as TestPage;
	page.onShow();
	return { page, runtime };
}

afterEach(() => vi.unstubAllGlobals());

describe("sensitive account page lifecycle", () => {
	it("drops a late challenge after leaving login and removes native inputs", async () => {
		const request = deferred<{ challengeId: string; maskedTarget: string }>();
		const { page } = await loadPage("login", {
			requestPhoneChallenge: () => request.promise,
		});
		Object.assign(page.data, {
			busy: false,
			remoteReady: true,
			phoneEnabled: true,
			method: "PHONE",
			phonePurpose: "LOGIN",
		});
		page.phoneInput = "13800000000";
		const pending = page.onRequestCode();
		page.onHide();
		request.resolve({
			challengeId: "fixture-only",
			maskedTarget: "+86138****0000",
		});
		await pending;
		expect(page.challengeId).toBeNull();
		expect(page.phoneInput).toBe("");
		expect(page.data.pageActive).toBe(false);
		expect(page.data.challengeSent).toBe(false);
		expect(page.data.maskedTarget).toBe("");
	});

	it("does not navigate from a login response that arrives after hiding", async () => {
		const request = deferred<{ kind: string }>();
		const { page, runtime } = await loadPage("login", {
			loginWithPhone: () => request.promise,
		});
		Object.assign(page.data, {
			busy: false,
			remoteReady: true,
			method: "PHONE",
			phonePurpose: "LOGIN",
		});
		page.phoneInput = "13800000000";
		page.otpInput = "000000";
		page.challengeId = "fixture-only";
		page.challengeScope = page.currentChallengeScope();
		const pending = page.onSubmit();
		page.onHide();
		request.resolve({ kind: "SIGNED_IN" });
		await pending;
		expect(runtime.reLaunch).not.toHaveBeenCalled();
		expect(page.otpInput).toBe("");
	});

	it("locks method and target while sending, and invalidates a challenge on target change", async () => {
		const request = deferred<{ challengeId: string; maskedTarget: string }>();
		const { page } = await loadPage("login", {
			requestPhoneChallenge: () => request.promise,
		});
		Object.assign(page.data, {
			busy: false,
			remoteReady: true,
			phoneEnabled: true,
			emailEnabled: true,
			method: "PHONE",
			phonePurpose: "LOGIN",
		});
		page.phoneInput = "13800000000";
		const pending = page.onRequestCode();
		page.onMethodChange({ currentTarget: { dataset: { method: "EMAIL" } } });
		page.onPhoneInput({ detail: { value: "13900000000" } });
		expect(page.data.method).toBe("PHONE");
		expect(page.phoneInput).toBe("13800000000");
		request.resolve({
			challengeId: "fixture-only",
			maskedTarget: "+86138****0000",
		});
		await pending;
		page.onPhoneInput({ detail: { value: "13900000000" } });
		expect(page.challengeId).toBeNull();
		expect(page.challengeScope).toBeNull();
		expect(page.data.challengeSent).toBe(false);
	});

	it("rejects a challenge whose method, purpose, or target no longer matches", async () => {
		const login = vi.fn();
		const { page } = await loadPage("login", { loginWithPhone: login });
		Object.assign(page.data, {
			busy: false,
			remoteReady: true,
			method: "PHONE",
			phonePurpose: "LOGIN",
		});
		page.phoneInput = "13800000000";
		page.challengeId = "fixture-only";
		page.challengeScope = "EMAIL:LOGIN:fixture@example.test";
		await page.onSubmit();
		expect(login).not.toHaveBeenCalled();
		expect(page.challengeId).toBeNull();
	});

	it("keeps verified export paths private, sends nothing automatically, and removes the file on leaving", async () => {
		const { page, runtime } = await loadPage("account", {
			downloadAccountExport: async () => ({
				savedFilePath: "/private/fixture-export.json",
			}),
		});
		Object.assign(page.data, {
			busy: false,
			remoteReady: true,
			dataExportEnabled: true,
		});
		page.currentExport = { status: "READY" };
		await page.onDownloadExport();
		expect(page.data.exportFileReady).toBe(true);
		expect(JSON.stringify(page.data)).not.toContain("/private/");
		expect(runtime.shareFileMessage).not.toHaveBeenCalled();
		page.onHide();
		expect(runtime.unlink).toHaveBeenCalledWith("/private/fixture-export.json");
		expect(page.verifiedExportPath).toBeNull();
	});

	it("retains a user-confirmed native handoff file until the native callback, then removes it without late page writes", async () => {
		const { page, runtime } = await loadPage("account", {});
		Object.assign(page.data, {
			busy: false,
			remoteReady: true,
			dataExportEnabled: true,
			exportFileReady: true,
		});
		page.verifiedExportPath = "/private/fixture-export.json";
		await page.onTakeExport();
		expect(runtime.showModal).toHaveBeenCalledOnce();
		expect(runtime.shareFileMessage).toHaveBeenCalledOnce();
		page.onHide();
		expect(runtime.unlink).not.toHaveBeenCalled();
		const snapshot = { ...page.data };
		const options = runtime.shareFileMessage.mock.calls[0]?.[0];
		options.fail();
		options.complete();
		expect(runtime.unlink).toHaveBeenCalledWith("/private/fixture-export.json");
		expect(page.exportHandoffInFlight).toBe(false);
		expect(page.verifiedExportPath).toBeNull();
		expect(page.data).toEqual(snapshot);
	});

	it("does not restore account data or navigate after a late account response", async () => {
		const request = deferred<{ kind: string }>();
		const { page, runtime } = await loadPage("account", {
			syncAccount: () => request.promise,
		});
		Object.assign(page.data, { busy: false, remoteReady: true });
		const pending = page.loadAccount();
		page.onHide();
		request.resolve({ kind: "SIGNED_OUT" });
		await pending;
		expect(runtime.reLaunch).not.toHaveBeenCalled();
		expect(page.data.bindings).toEqual([]);
		expect(page.data.sessions).toEqual([]);
	});

	it("suppresses late challenge failures as well as successful replies", async () => {
		const request = deferred<never>();
		const { page } = await loadPage("login", {
			requestPhoneChallenge: () => request.promise,
		});
		Object.assign(page.data, {
			busy: false,
			remoteReady: true,
			phoneEnabled: true,
			method: "PHONE",
			phonePurpose: "LOGIN",
		});
		page.phoneInput = "13800000000";
		const pending = page.onRequestCode();
		page.onHide();
		const snapshot = { ...page.data };
		request.reject(new Error("fixture failure"));
		await pending;
		expect(page.data).toEqual(snapshot);
	});
});
