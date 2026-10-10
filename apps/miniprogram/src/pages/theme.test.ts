import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPageTheme, themedPage } from "./theme";

afterEach(() => vi.unstubAllGlobals());

describe("page theme lifecycle", () => {
	it("uses explicit appearance and native chrome without making requests", () => {
		const wx = {
			getAppBaseInfo: () => ({ theme: "light" }),
			setNavigationBarColor: vi.fn(),
			setBackgroundColor: vi.fn(),
			request: vi.fn(),
		};
		vi.stubGlobal("wx", wx);
		vi.stubGlobal("getApp", () => ({
			globalData: { preferences: { theme: () => "DARK" } },
		}));
		const page = { setData: vi.fn() };
		applyPageTheme(page);
		expect(page.setData).toHaveBeenCalledWith({ themeClass: "theme-dark" });
		expect(wx.setNavigationBarColor).toHaveBeenCalledWith({
			frontColor: "#ffffff",
			backgroundColor: "#101827",
		});
		expect(wx.request).not.toHaveBeenCalled();
	});

	it("registers without runtime work, observes system theme while visible, and detaches on hide", () => {
		let registered: Record<string, (...args: unknown[]) => unknown> = {};
		let listener: (event: { theme: string }) => void = () => {};
		const wx = {
			getAppBaseInfo: vi.fn(() => ({ theme: "light" })),
			onThemeChange: vi.fn((callback) => {
				listener = callback;
			}),
			offThemeChange: vi.fn(),
		};
		vi.stubGlobal("wx", wx);
		vi.stubGlobal("getApp", () => ({
			globalData: { preferences: { theme: () => "SYSTEM" } },
		}));
		vi.stubGlobal("Page", (options) => {
			registered = options;
		});
		const originalShow = vi.fn(),
			originalHide = vi.fn();
		themedPage({ onShow: originalShow, onHide: originalHide });
		expect(wx.getAppBaseInfo).not.toHaveBeenCalled();
		const page = { setData: vi.fn() };
		registered.onShow?.call(page);
		listener({ theme: "dark" });
		expect(page.setData).toHaveBeenLastCalledWith({ themeClass: "theme-dark" });
		registered.onHide?.call(page);
		expect(wx.offThemeChange).toHaveBeenCalledWith(listener);
		expect(originalShow).toHaveBeenCalledOnce();
		expect(originalHide).toHaveBeenCalledOnce();
	});
});
