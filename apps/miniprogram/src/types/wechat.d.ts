interface WxLoginResult {
	code?: string;
}

interface WxRequestResult {
	statusCode: number;
	data: unknown;
	header?: Record<string, unknown>;
}

interface WxInputEvent {
	detail: { value: string };
}

interface WxTapEvent {
	currentTarget: { dataset: Record<string, unknown> };
}

interface WxSwitchEvent {
	detail: { value: boolean };
}

interface WxRuntime {
	login(options: {
		timeout?: number;
		success(result: WxLoginResult): void;
		fail(): void;
	}): void;
	request(options: {
		url: string;
		method: "GET" | "POST" | "DELETE";
		data?: unknown;
		header: Record<string, string>;
		timeout: number;
		success(result: WxRequestResult): void;
		fail(): void;
	}): unknown;
	getStorageSync(key: string): unknown;
	setStorageSync(key: string, value: unknown): void;
	removeStorageSync(key: string): void;
	getExtConfigSync?(): Record<string, unknown>;
	hideShareMenu?(options?: { menus?: string[] }): void;
	getRandomValues(options: {
		length: number;
		success(result: { randomValues: ArrayBuffer }): void;
		fail(): void;
	}): void;
	redirectTo(options: { url: string }): void;
	navigateTo(options: { url: string }): void;
	reLaunch(options: { url: string }): void;
	navigateBack(options?: { delta?: number }): void;
	showToast(options: {
		title: string;
		icon?: "success" | "error" | "none";
		duration?: number;
	}): void;
	showModal(options: {
		title: string;
		content: string;
		showCancel?: boolean;
		confirmText?: string;
		confirmColor?: string;
		cancelText?: string;
		success(result: { confirm: boolean; cancel: boolean }): void;
		fail?(): void;
	}): void;
	getLocation(options: {
		type: "wgs84" | "gcj02";
		isHighAccuracy?: boolean;
		highAccuracyExpireTime?: number;
		success(result: {
			latitude: number;
			longitude: number;
			accuracy?: number;
		}): void;
		fail(): void;
	}): void;
	openLocation(options: {
		latitude: number;
		longitude: number;
		name?: string;
		address?: string;
	}): void;
	makePhoneCall(options: { phoneNumber: string }): void;
	setClipboardData(options: {
		data: string;
		success?(): void;
		fail?(): void;
	}): void;
	downloadFile(options: {
		url: string;
		header: Record<string, string>;
		timeout: number;
		success(result: {
			statusCode: number;
			tempFilePath: string;
		}): void;
		fail(): void;
	}): unknown;
	getFileSystemManager(): {
		readFile(options: {
			filePath: string;
			success(result: { data: string | ArrayBuffer }): void;
			fail(): void;
		}): void;
		saveFileSync(tempFilePath: string): string;
		unlinkSync(filePath: string): void;
	};
}

interface MiniProgramPageInstance {
	setData(data: object): void;
}

declare const wx: WxRuntime;
declare function App<T extends object>(options: T): void;
declare function Page<T extends object>(
	options: T & ThisType<T & MiniProgramPageInstance>,
): void;
declare function getApp<T>(): T;
declare function getCurrentPages(): readonly { readonly route?: string }[];
