import type { ChiShenMeMiniProgramApp } from "../app";

interface ThemeRuntime {
	getAppBaseInfo?(): { theme?: string };
	setNavigationBarColor?(options: {
		frontColor: "#ffffff" | "#000000";
		backgroundColor: string;
	}): void;
	setBackgroundColor?(options: { backgroundColor: string }): void;
	onThemeChange?(callback: (event: { theme: string }) => void): void;
	offThemeChange?(callback: (event: { theme: string }) => void): void;
}

const listeners = new WeakMap<object, (event: { theme: string }) => void>();

/** Apply the stored preference to content and native chrome without a network read. */
export function applyPageTheme(
	page: MiniProgramPageInstance,
	systemTheme?: string,
): void {
	const runtime = wx as unknown as ThemeRuntime;
	const preference =
		getApp<ChiShenMeMiniProgramApp>().globalData.preferences.theme();
	let platformTheme = systemTheme;
	if (platformTheme === undefined) {
		try {
			platformTheme = runtime.getAppBaseInfo?.().theme;
		} catch {
			platformTheme = "light";
		}
	}
	const dark =
		preference === "DARK" ||
		(preference === "SYSTEM" && platformTheme === "dark");
	page.setData({ themeClass: dark ? "theme-dark" : "theme-light" });
	const backgroundColor = dark ? "#101827" : "#f4f6fb";
	runtime.setNavigationBarColor?.({
		frontColor: dark ? "#ffffff" : "#000000",
		backgroundColor,
	});
	runtime.setBackgroundColor?.({ backgroundColor });
}

interface Lifecycle {
	onShow?: (this: MiniProgramPageInstance) => unknown;
	onHide?: (this: MiniProgramPageInstance) => unknown;
	onUnload?: (this: MiniProgramPageInstance) => unknown;
}

export function themedPage<T extends object>(
	options: T & ThisType<T & MiniProgramPageInstance>,
): void {
	const lifecycle = options as T & Lifecycle;
	const detach = (page: MiniProgramPageInstance) => {
		const listener = listeners.get(page);
		if (listener) (wx as unknown as ThemeRuntime).offThemeChange?.(listener);
		listeners.delete(page);
	};
	Page({
		...options,
		onShow(this: MiniProgramPageInstance) {
			detach(this);
			applyPageTheme(this);
			const listener = (event: { theme: string }) =>
				applyPageTheme(this, event.theme);
			listeners.set(this, listener);
			(wx as unknown as ThemeRuntime).onThemeChange?.(listener);
			return lifecycle.onShow?.call(this);
		},
		onHide(this: MiniProgramPageInstance) {
			detach(this);
			return lifecycle.onHide?.call(this);
		},
		onUnload(this: MiniProgramPageInstance) {
			detach(this);
			return lifecycle.onUnload?.call(this);
		},
	});
}
