"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { AdminClientError, loginWithPasskey } from "../../lib/admin-client";

export default function AdminLoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("logout") === "unconfirmed") {
      setMessage("本浏览器的管理员令牌已清除，但服务端撤销结果未确认；重新登录前请联系安全负责人核查会话列表。");
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = login.trim();
    if (!/^[\p{L}\p{N}._@+-]{3,128}$/u.test(normalized)) {
      setMessage("请输入有效的管理员登录名");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await loginWithPasskey(normalized);
      router.replace("/");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof AdminClientError ? error.message : "Passkey 登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="login-card" aria-labelledby="login-title">
      <div className="brand-mark" aria-hidden="true">食</div>
      <p className="eyebrow">ADMINISTRATOR ACCESS</p>
      <h1 id="login-title">管理员 Passkey 登录</h1>
      <p className="page-description">
        后台不支持密码或短信登录。只有已由公司离线引导、状态有效且持有已登记 Passkey 的管理员可以进入。
      </p>
      <form className="admin-form" onSubmit={submit}>
        <label htmlFor="admin-login">管理员登录名</label>
        <input
          id="admin-login"
          name="login"
          autoComplete="username webauthn"
          inputMode="email"
          maxLength={128}
          value={login}
          onChange={(event) => setLogin(event.target.value)}
          disabled={busy}
          required
        />
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "正在验证…" : "使用 Passkey 登录"}
        </button>
      </form>
      {message !== null && <p className="form-message form-error" role="alert">{message}</p>}
      <p className="security-note">登录令牌只保存在 HttpOnly Cookie 中，不会交给页面脚本或本地存储。</p>
    </section>
  );
}
