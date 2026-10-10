import type { LocationChoice, LocationFailureKind } from "./types";

export class LocationProviderError extends Error {
	constructor(
		readonly kind: LocationFailureKind,
		message: string,
	) {
		super(message);
		this.name = "LocationProviderError";
	}
}

export interface LocationProvider {
	currentLocation(): Promise<LocationChoice>;
	cancel?(): void;
}

export interface WechatLocationRuntime {
	requirePrivacyAuthorize?(options: {
		readonly success: () => void;
		readonly fail: () => void;
	}): void;
	getLocation(options: {
		readonly type: "wgs84";
		readonly isHighAccuracy: boolean;
		readonly highAccuracyExpireTime: number;
		readonly success: (result: {
			readonly latitude: number;
			readonly longitude: number;
			readonly accuracy?: number;
		}) => void;
		readonly fail: (error: { readonly errMsg?: string }) => void;
	}): void;
	getSetting?(options: {
		readonly success: (result: {
			readonly authSetting?: Record<string, boolean | undefined>;
		}) => void;
		readonly fail: () => void;
	}): void;
}

export class WechatForegroundLocationProvider implements LocationProvider {
	private revision = 0;
	private pendingCancel: (() => void) | null = null;
	constructor(
		private readonly runtime: WechatLocationRuntime,
		private readonly personalDataAllowed: () => boolean = () => true,
	) {}

	cancel(): void {
		this.revision += 1;
		this.pendingCancel?.();
		this.pendingCancel = null;
	}

	async currentLocation(): Promise<LocationChoice> {
		this.cancel();
		const revision = this.revision;
		if (!this.personalDataAllowed()) {
			return Promise.reject(
				new LocationProviderError(
					"PRIVACY_REQUIRED",
					"请先阅读并同意隐私说明，再使用本次定位",
				),
			);
		}
		if (this.runtime.requirePrivacyAuthorize === undefined) {
			throw new LocationProviderError(
				"PRIVACY_REQUIRED",
				"当前微信版本无法确认平台隐私授权，请更新微信或手动选址",
			);
		}
		await new Promise<void>((resolve, reject) => {
			this.pendingCancel = () =>
				reject(
					new LocationProviderError("CANCELLED", "已取消定位，可手动选择地点"),
				);
			try {
				this.runtime.requirePrivacyAuthorize?.({
					success: () => resolve(),
					fail: () =>
						reject(
							new LocationProviderError(
								"PRIVACY_REQUIRED",
								"需同意微信平台隐私授权后才能定位，也可手动选址",
							),
						),
				});
			} catch {
				reject(
					new LocationProviderError(
						"UNAVAILABLE",
						"暂时无法确认平台隐私授权，请手动选择地点",
					),
				);
			}
		});
		if (!this.personalDataAllowed() || revision !== this.revision)
			throw new LocationProviderError(
				"CANCELLED",
				"已取消定位，可手动选择地点",
			);
		return new Promise<LocationChoice>((resolve, reject) => {
			this.pendingCancel = () =>
				reject(
					new LocationProviderError("CANCELLED", "已取消定位，可手动选择地点"),
				);
			this.runtime.getLocation({
				type: "wgs84",
				isHighAccuracy: false,
				highAccuracyExpireTime: 3_000,
				success: (result) => {
					if (!this.personalDataAllowed() || revision !== this.revision) {
						reject(
							new LocationProviderError(
								"CANCELLED",
								"已取消定位，可手动选择地点",
							),
						);
						return;
					}
					if (
						!Number.isFinite(result.latitude) ||
						result.latitude < -90 ||
						result.latitude > 90 ||
						!Number.isFinite(result.longitude) ||
						result.longitude < -180 ||
						result.longitude > 180
					) {
						reject(
							new LocationProviderError(
								"UNAVAILABLE",
								"定位结果不可用，请手动选择地点",
							),
						);
						return;
					}
					const accuracy = result.accuracy;
					const coordinate =
						typeof accuracy === "number" &&
						Number.isFinite(accuracy) &&
						accuracy >= 0 &&
						accuracy <= 10_000
							? {
									latitude: result.latitude,
									longitude: result.longitude,
									accuracyMeters: accuracy,
									crs: "WGS84" as const,
								}
							: {
									latitude: result.latitude,
									longitude: result.longitude,
									crs: "WGS84" as const,
								};
					resolve(
						Object.freeze({
							label: "当前位置（仅用于本次决策）",
							coordinate: Object.freeze(coordinate),
							isDemonstration: false,
							isApproximate: true,
						}),
					);
				},
				fail: (error) => {
					if (!this.personalDataAllowed() || revision !== this.revision) {
						reject(
							new LocationProviderError(
								"CANCELLED",
								"已取消定位，可手动选择地点",
							),
						);
						return;
					}
					const message = error.errMsg ?? "";
					if (isPermissionFailure(message)) {
						this.permissionFailure(reject);
					} else if (/cancel/iu.test(message)) {
						reject(
							new LocationProviderError(
								"CANCELLED",
								"已取消定位，可手动选择地点",
							),
						);
					} else {
						reject(
							new LocationProviderError(
								"UNAVAILABLE",
								"暂时无法定位，请手动选择地点",
							),
						);
					}
				},
			});
		}).finally(() => {
			if (revision === this.revision) this.pendingCancel = null;
		});
	}

	private permissionFailure(
		reject: (reason: LocationProviderError) => void,
	): void {
		if (this.runtime.getSetting === undefined) {
			reject(
				new LocationProviderError(
					"PERMISSION_DENIED",
					"未获得定位权限，请手动选择地点",
				),
			);
			return;
		}
		this.runtime.getSetting({
			success: (settings) => {
				const denied = settings.authSetting?.["scope.userLocation"] === false;
				reject(
					new LocationProviderError(
						denied ? "PERMISSION_PERMANENTLY_DENIED" : "PERMISSION_DENIED",
						denied
							? "定位权限已关闭，可在微信设置中开启，或直接手动选择地点"
							: "未获得定位权限，请手动选择地点",
					),
				);
			},
			fail: () =>
				reject(
					new LocationProviderError(
						"PERMISSION_DENIED",
						"未获得定位权限，请手动选择地点",
					),
				),
		});
	}
}

function isPermissionFailure(message: string): boolean {
	return /auth(?:orize)?\s*(?:deny|denied)|permission\s*(?:deny|denied)|scope\.userLocation/iu.test(
		message,
	);
}
