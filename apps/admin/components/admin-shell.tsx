"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import type { AdminPermission, AdminSession } from "../lib/admin-contract";
import { AdminClientError, loadSession, logout } from "../lib/admin-client";

interface SessionContextValue {
  session: AdminSession;
  hasPermission(permission: AdminPermission): boolean;
  endSession(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const navigation = [
  { href: "/", mark: "总", label: "运营总览" },
  { href: "/configuration", mark: "配", label: "推荐配置" },
  { href: "/health", mark: "康", label: "系统健康" },
  { href: "/diagnostics", mark: "诊", label: "推荐诊断" },
  { href: "/audit", mark: "审", label: "安全审计" },
  { href: "/security", mark: "安", label: "Passkey 与会话" }
] as const;

export function useAdminSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (context === null) throw new Error("管理员会话上下文不可用");
  return context;
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<AdminSession | null>(null);
  const [loading, setLoading] = useState(pathname !== "/login");
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    if (pathname === "/login") {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setSessionError(null);
    void loadSession()
      .then((value) => {
        if (!active) return;
        setSession(value);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSession(null);
        setLoading(false);
        if (error instanceof AdminClientError && error.status === 401) {
          router.replace("/login");
        } else {
          setSessionError(error instanceof AdminClientError ? error.message : "管理员会话暂时无法验证");
        }
      });
    return () => {
      active = false;
    };
  }, [pathname, router]);

  const endSession = useCallback(async () => {
    let serverRevocationConfirmed = true;
    try {
      await logout();
    } catch {
      serverRevocationConfirmed = false;
    } finally {
      setSession(null);
      router.replace(serverRevocationConfirmed ? "/login" : "/login?logout=unconfirmed");
      router.refresh();
    }
  }, [router]);

  const context = useMemo<SessionContextValue | null>(() => {
    if (session === null) return null;
    return {
      session,
      hasPermission: (permission) => session.permissions.includes(permission),
      endSession
    };
  }, [endSession, session]);

  if (pathname === "/login") {
    return <main className="login-main" id="main-content">{children}</main>;
  }

  if (loading || context === null) {
    return (
      <main className="session-loading" id="main-content" aria-live="polite">
        <div className="panel">
          <strong>{loading ? "正在验证管理员会话…" : sessionError ?? "管理员会话不可用"}</strong>
          {!loading && sessionError !== null && (
            <p><button className="quiet-button" type="button" onClick={() => window.location.reload()}>重新验证</button></p>
          )}
        </div>
      </main>
    );
  }

  return (
    <SessionContext.Provider value={context}>
      <div className="app-shell">
        <aside className="sidebar">
          <Link className="brand" href="/" aria-label="吃什么运营控制台首页">
            <span className="brand-mark" aria-hidden="true">食</span>
            <span><strong>吃什么</strong><small>运营控制台</small></span>
          </Link>
          <nav aria-label="主导航">
            {navigation.map((item) => (
              <Link href={item.href} key={item.href} aria-current={pathname === item.href ? "page" : undefined}>
                <span aria-hidden="true">{item.mark}</span>{item.label}
              </Link>
            ))}
          </nav>
          <div className="sidebar-note">
            <strong>Passkey 安全会话</strong>
            <p>15 分钟空闲超时；权限由服务端 RBAC 逐请求复核，浏览器脚本无法读取会话令牌。</p>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <p>Android 内测运营环境</p>
            <button className="quiet-button" type="button" onClick={() => void endSession()}>安全退出</button>
          </header>
          <main id="main-content">{children}</main>
          <footer>© 2026 吃什么 · 未完成合规门禁前不得公开发布</footer>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
