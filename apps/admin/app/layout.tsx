import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminShell } from "../components/admin-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "吃什么 · 运营控制台", template: "%s · 吃什么运营控制台" },
  description: "吃什么 Android 内测阶段的 Passkey 与 RBAC 运营管理后台"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
