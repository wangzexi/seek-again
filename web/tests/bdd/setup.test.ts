import { afterAll, beforeAll, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { openApp, start, stop, strict } from "./support/world.js";

if (strict) {
  beforeAll(start);
  afterAll(stop);

  const skip = "Skip this step";
  const qr = "DeepSeek sign-in QR code";
  const key = "sk-fixture-replacement";
  const routeName = (url: string) => new URL(url).pathname.replace("/api/deepseek-import", "");
  const qrHeaders = { "x-wechat-qr-id": "qr-fixture" };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=",
    "base64",
  );

  test("refreshes expired QR, imports locally, and retries key setup without re-importing", async () => {
    const date = "2026-11-16T00:00:00Z";
    const session = {
      id: "session-fixture",
      title: "Fixture history",
      pinned: false,
      inserted_at: date,
      updated_at: date,
    };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ export_format_version: 3 })),
      "chat_sessions/session-fixture.json": strToU8(
        JSON.stringify({
          ...session,
          current_message_id: 1,
          messages: [
            {
              id: 1,
              parent_id: null,
              role: "USER",
              status: "FINISHED",
              thinking_enabled: false,
              search_enabled: false,
              accumulated_token_usage: 0,
              inserted_at: date,
              fragments: [{ type: "REQUEST", content: "Imported message" }],
            },
          ],
        }),
      ),
      "chat_session_index.json": strToU8(JSON.stringify([{ ...session, message_count: 1 }])),
    });
    let scans = 0;
    const exchanges: string[] = [];
    let exports = 0;
    let keyAttempts = 0;
    let revokeAttempts = 0;
    const targets: string[] = [];
    const app = await openApp(async (route) => {
      const request = route.request();
      const path = routeName(request.url());
      const token = request.headers().authorization;
      switch (path) {
        case "/qr": {
          const { target } = request.postDataJSON();
          targets.push(target);
          return route.fulfill({ body: png, contentType: "image/png", headers: qrHeaders });
        }
        case "/authorize": {
          const { target, id } = request.postDataJSON();
          expect(id).toBe(qrHeaders["x-wechat-qr-id"]);
          if (target === "chat") {
            const scan = scans++;
            if (scan === 0) return route.fulfill({ json: { state: "expired" } });
            if (scan === 1) return route.abort();
            if (scan === 2) return route.fulfill({ status: 504, body: "Gateway timeout" });
            await request.frame().evaluate(() => {
              Object.defineProperty(document, "hidden", { configurable: true, value: true });
              document.dispatchEvent(new Event("visibilitychange"));
            });
          }
          return route.fulfill({ json: { state: "scanned", code: target + "-code" } });
        }
        case "/exchange": {
          const { target, code } = request.postDataJSON();
          expect(code).toBe(target + "-code");
          exchanges.push(target);
          return route.fulfill({ json: { state: "authorized", token: target + "-token" } });
        }
        case "/export":
          expect(token).toBe("Bearer chat-token");
          exports++;
          return route.fulfill({ json: {} });
        case "/export/status":
          expect(token).toBe("Bearer chat-token");
          return route.fulfill({ json: { archiveUrl: "https://archive.invalid/history.zip" } });
        case "/archive":
          expect(token).toBe("Bearer chat-token");
          return route.fulfill({
            contentType: "application/zip",
            headers: { "x-archive-size": String(zip.byteLength) },
            body: Buffer.from(zip),
          });
        case "/key":
          if (token === "Bearer chat-token") {
            return route.fulfill({ status: 401, json: { error: "platformSignIn" } });
          }
          expect(token).toBe("Bearer platform-token");
          if (keyAttempts++ === 0) {
            return route.abort();
          }
          return route.fulfill({ json: { apiKey: key } });
        case "/revoke-key":
          revokeAttempts++;
          expect(token).toBe("Bearer platform-token");
          expect(request.postData()).toBeNull();
          return route.fulfill({ status: 401, json: { error: "platformSignIn" } });
        default:
          throw new Error("Unexpected setup request " + path);
      }
    });
    try {
      const { page } = app;
      await page.route("https://archive.invalid/**", (route) => route.abort());
      const scanConfirmation = page.waitForResponse(
        async (response) =>
          routeName(response.url()) === "/authorize" &&
          response.status() === 200 &&
          response.request().postDataJSON().target === "chat" &&
          (await response.json()).state === "scanned",
      );
      await page.getByRole("button", { name: "Refresh expired QR code" }).click();
      await scanConfirmation;
      // A confirmed scan must not exchange the single-use code in the background.
      await page.waitForTimeout(250);
      expect(exchanges).toEqual([]);
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.getByRole("button", { name: "Retry" }).click();
      await page.getByText(/Created an API key named/).waitFor();
      await page.getByText("Fixture history", { exact: true }).waitFor();
      expect(scans).toBe(4);
      expect(exchanges).toEqual(["chat", "platform"]);
      expect(targets).toEqual(["chat", "chat", "platform"]);
      expect(exports).toBe(1);
      expect(keyAttempts).toBe(2);
      expect(
        await page.evaluate(() => [
          localStorage.getItem("chat-demo:deepseek-chat-token"),
          localStorage.getItem("chat-demo:deepseek-platform-token"),
          localStorage.getItem("chat-demo:access-token"),
        ]),
      ).toEqual(["chat-token", "platform-token", key]);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      const signOut = settings.getByRole("button", { name: "Sign out", exact: true });
      const confirmSignOut = page.getByRole("dialog", {
        name: "Sign out of your DeepSeek account and API Platform",
      });
      await signOut.click();
      await confirmSignOut.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(revokeAttempts).toBe(0);
      expect(await page.evaluate(() => localStorage.getItem("chat-demo:access-token"))).toBe(key);
      await signOut.click();
      await confirmSignOut.getByRole("button", { name: "Sign out", exact: true }).click();
      await page
        .getByText("Signed out on this device, but the API key could not be revoked.")
        .waitFor();
      expect(
        await page.evaluate(() => [
          localStorage.getItem("chat-demo:deepseek-chat-token"),
          localStorage.getItem("chat-demo:deepseek-platform-token"),
          localStorage.getItem("chat-demo:access-token"),
        ]),
      ).toEqual([null, null, null]);
      expect(revokeAttempts).toBe(1);
      await settings.getByRole("button", { name: "Delete", exact: true }).click();
      const confirmDelete = page.getByRole("dialog", {
        name: "Permanently delete all local chats?",
      });
      await confirmDelete.getByText(/permanently deletes all chats on this device/).waitFor();
      await confirmDelete.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByText("Fixture history", { exact: true }).waitFor();
    } finally {
      await app.close();
    }
  }, 15_000);

  test("skips setup locally and opens API-only setup when sending without a key", async () => {
    const targets: string[] = [];
    let finishSetup = false;
    const app = await openApp(async (route) => {
      const path = routeName(route.request().url());
      if (path === "/qr") {
        targets.push(route.request().postDataJSON().target);
        return route.fulfill({ body: png, contentType: "image/png", headers: qrHeaders });
      }
      if (path === "/key") return route.fulfill({ json: { apiKey: key } });
      if (path === "/exchange") {
        return route.fulfill({ json: { state: "authorized", token: "platform-token" } });
      }
      expect(path).toBe("/authorize");
      if (finishSetup) {
        return route.fulfill({ json: { state: "scanned", code: "platform-code" } });
      }
      return route.fulfill({ json: { state: "pending" } });
    });
    try {
      const { page } = app;
      await page.getByAltText(qr).waitFor();
      await page.getByRole("button", { name: skip }).click();
      await page.waitForFunction(() =>
        document.querySelector('[aria-current="step"]')?.textContent?.includes("DeepSeek API"),
      );
      await page.getByAltText(qr).waitFor();
      await page.getByRole("button", { name: skip }).click();
      await page.getByText(/API setup skipped/).waitFor();
      expect(targets).toEqual(["chat", "platform"]);
      await page.keyboard.press("Escape");
      const balanceAttempts: number[] = [];
      await page.route("**/api/deepseek/user/balance", (route) => {
        expect(route.request().headers().authorization).toBe("Bearer " + key);
        balanceAttempts.push(Date.now());
        if (balanceAttempts.length < 3) {
          return route.fulfill({
            status: 401,
            json: { error: { message: "Key not yet recognized" } },
          });
        }
        return route.fulfill({
          json: { balance_infos: [{ currency: "CNY", total_balance: "0.00" }] },
        });
      });
      finishSetup = true;
      const input = page.getByPlaceholder("Enter a message");
      await input.fill("Keep this draft");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const setup = page.getByRole("dialog");
      await setup.getByText("Checking balance in 3s…", { exact: true }).waitFor();
      await setup.getByText("API balance checked: CNY 0.00. You can scan to top up.").waitFor();
      expect(balanceAttempts).toHaveLength(3);
      expect(balanceAttempts[1] - balanceAttempts[0]).toBeGreaterThanOrEqual(2700);
      expect(balanceAttempts[2] - balanceAttempts[1]).toBeGreaterThanOrEqual(2700);
      expect(
        await page.evaluate(() => [
          localStorage.getItem("chat-demo:access-token"),
          localStorage.getItem("chat-demo:deepseek-platform-token"),
        ]),
      ).toEqual([key, "platform-token"]);
      await setup.getByRole("button", { name: "Top up", exact: true }).click();
      const recharge = page.getByRole("dialog", { name: "Top up DeepSeek API" });
      await recharge.waitFor();
      await page.keyboard.press("Escape");
      await recharge.waitFor({ state: "hidden" });
      await setup.getByRole("button", { name: skip }).click();
      await setup.getByRole("button", { name: "Start chatting" }).waitFor();
      expect(await setup.getByText("Scan with WeChat to sign in to DeepSeek Chat").count()).toBe(0);
      expect(targets).toEqual(["chat", "platform", "platform"]);
      await page.keyboard.press("Escape");
      expect(await input.inputValue()).toBe("Keep this draft");
    } finally {
      await app.close();
    }
  }, 20_000);

  test("an invalid archive does not start API setup", async () => {
    const requests: string[] = [];
    const app = await openApp(async (route) => {
      const path = routeName(route.request().url());
      requests.push(path);
      if (path === "/qr")
        return route.fulfill({ body: png, contentType: "image/png", headers: qrHeaders });
      if (path === "/authorize")
        return route.fulfill({ json: { state: "scanned", code: "chat-code" } });
      if (path === "/exchange")
        return route.fulfill({ json: { state: "authorized", token: "chat-token" } });
      if (path === "/export")
        return route.fulfill({ json: { archiveUrl: "http://archive.invalid/history.zip" } });
      if (path === "/archive") return route.fulfill({ body: "invalid zip" });
      throw new Error("Unexpected setup request " + path);
    });
    try {
      await app.page.getByRole("alert").waitFor();
      expect(requests).toEqual(["/qr", "/authorize", "/exchange", "/export", "/archive"]);
      await app.page.getByRole("button", { name: "Retry" }).waitFor();
    } finally {
      await app.close();
    }
  });
}
