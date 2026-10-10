import { isWechatLoginCode } from "./contracts";

interface LoginRuntime {
	login(options: {
		timeout?: number;
		success(result: WxLoginResult): void;
		fail(): void;
	}): void;
}

export function requestWechatLoginCode(runtime: LoginRuntime): Promise<string> {
	return new Promise((resolve, reject) => {
		runtime.login({
			timeout: 10_000,
			success: (result) => {
				if (!isWechatLoginCode(result.code)) {
					reject(new Error("WECHAT_CODE_INVALID"));
					return;
				}
				resolve(result.code);
			},
			fail: () => reject(new Error("WECHAT_LOGIN_FAILED")),
		});
	});
}
