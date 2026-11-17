import React, { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { GitHubIcon } from "./icons";

interface LoginViewProps {
  signedOut: boolean;
  onAuthenticated?: () => void;
}

function getSafeNext(): string | null {
  const next = new URLSearchParams(location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
}

function getDirectDeviceCode(): string | null {
  const code = new URLSearchParams(location.search).get("device_code")?.trim();
  return code || null;
}

function extractPendingDeviceCode(
  directDeviceCode: string | null,
  safeNext: string | null
): string | null {
  if (directDeviceCode) return directDeviceCode;
  if (!safeNext) return null;
  try {
    const parsed = new URL(safeNext, location.origin);
    return parsed.searchParams.get("device_code")?.trim() || null;
  } catch {
    return null;
  }
}

function formatAuthError(code: string | null): string | null {
  if (!code) return null;
  if (code === "unauthorized") {
    return "该 GitHub 账号未开通访问权限，请联系管理员。";
  }
  if (code === "github_failed" || code === "oauth_failed") {
    return "GitHub 登录验证失败，请重试。";
  }
  return code;
}

export function LoginView({ signedOut, onAuthenticated }: LoginViewProps) {
  const urlAuthError = formatAuthError(
    new URLSearchParams(location.search).get("auth_error")
  );

  const [devSubmitting, setDevSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(urlAuthError);

  const oauthEnabled =
    document.querySelector('meta[name="hp-oauth"]')?.getAttribute("content") !== "0";
  const devLoginEnabled =
    document.querySelector('meta[name="hp-dev-login"]')?.getAttribute("content") === "1";

  const safeNext = getSafeNext();
  const directDeviceCode = getDirectDeviceCode();
  const pendingDeviceCode = extractPendingDeviceCode(directDeviceCode, safeNext);

  const nextPath =
    safeNext ||
    (directDeviceCode
      ? `/dashboard?device_code=${encodeURIComponent(directDeviceCode)}${location.hash || ""}`
      : `/dashboard${location.hash || ""}`);
  const loginHref = "/auth/login?next=" + encodeURIComponent(nextPath);

  const handleDevLogin = async () => {
    setDevSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/auth/dev-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "本地开发登录失败，请重试。");
      }
      if (safeNext) {
        location.href = safeNext;
      } else if (onAuthenticated) {
        const kept = new URLSearchParams();
        if (directDeviceCode) {
          kept.set("device_code", directDeviceCode);
        }
        const qs = kept.toString();
        history.replaceState(
          null,
          "",
          "/dashboard" + (qs ? `?${qs}` : "") + (location.hash || "")
        );
        onAuthenticated();
      } else {
        location.href = nextPath;
      }
    } catch (err: any) {
      setErrorMsg(err.message || "本地开发登录失败，请重试。");
    } finally {
      setDevSubmitting(false);
    }
  };

  return (
    <div className="hp-auth-shell" id="login-view">
      <main className="hp-auth-main">
        <Card maxWidth={440} elevation="low" className="hp-auth-card">
          <Stack gap={4} align="stretch">
            <div className="hp-auth-brand">
              <span className="hp-brand-code" aria-hidden="true">&lt;/&gt;</span>
              <strong>html-preview</strong>
            </div>

            <Heading level={1}>
              {signedOut ? "你已退出 html-preview" : "登录 html-preview"}
            </Heading>

            {pendingDeviceCode && (
              <div className="hp-info-banner" id="login-device-notice">
                登录后将继续审批 CLI 设备登录（设备码：
                <code>{pendingDeviceCode.toUpperCase()}</code>）
              </div>
            )}

            {errorMsg && (
              <div className="hp-error-banner" id="login-error-box" role="alert">
                {errorMsg}
              </div>
            )}

            {oauthEnabled ? (
              <Button
                variant="primary"
                size="lg"
                width="100%"
                href={loginHref}
                icon={<GitHubIcon />}
                label="使用 GitHub 登录"
              />
            ) : (
              !devLoginEnabled && (
                <div className="hp-error-banner" role="alert">
                  当前实例尚未配置 GitHub OAuth，请联系管理员完成配置。
                </div>
              )
            )}

            {devLoginEnabled && (
              <>
                {oauthEnabled && (
                  <div className="hp-divider-row">
                    <Divider />
                    <span className="hp-divider-label">仅限本地开发环境</span>
                    <Divider />
                  </div>
                )}
                <Button
                  id="btn-dev-login"
                  variant={oauthEnabled ? "secondary" : "primary"}
                  width="100%"
                  label="本地开发登录"
                  isLoading={devSubmitting}
                  onClick={handleDevLogin}
                />
              </>
            )}
          </Stack>
        </Card>
      </main>
    </div>
  );
}
