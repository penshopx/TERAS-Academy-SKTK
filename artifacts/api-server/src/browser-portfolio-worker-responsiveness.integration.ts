/// <reference lib="dom" />
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import { chromium } from "playwright";
import { BrowserTestIdentityHarness } from "./browser-test-identity-harness.js";

const root = path.resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);
const chromiumPath = "/repl/tools/bin/chromium";
const documentId = "extreme-local-only-portfolio-marker";
const depth = 400_000;
const maxFileSize = 5 * 1024 * 1024;

async function main() {
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    // Exercise the emitted worker chunk, not a test double or the dev-server transform.
    await execFileAsync("pnpm", ["--filter", "@workspace/teras-academy", "exec", "vite", "build", "--config", "vite.config.ts"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        BASE_PATH: "/",
        PORT: "4173",
        // Exercise the actual public route without relying on workspace/CI credentials.
        VITE_SUPABASE_URL: "https://test.invalid",
        VITE_SUPABASE_ANON_KEY: "browser-fixture-not-a-credential",
      },
    });

    const app = express();
    app.get("/api/session", (_request, response) => response.status(401).json({ message: "Signed out" }));
    app.get("/api/*path", (_request, response) => response.json([]));
    const frontend = path.join(root, "artifacts/teras-academy/dist/public");
    app.use(express.static(frontend));
    app.get(/.*/, (_request, response) => response.sendFile(path.join(frontend, "index.html")));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string", "Portfolio worker browser fixture did not bind");

    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync(chromiumPath) ? chromiumPath : undefined),
    });
    const { page } = await BrowserTestIdentityHarness.createPage(browser, "portfolio-worker");
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${address.port}/verify-portfolio`);
    await page.getByRole("heading", { name: "Verifikasi file portfolio" }).waitFor();

    // Observe the native Worker without replacing its constructor, message handling, or payload.
    // Mark the active interval after structured cloning returns; a main-thread fallback would
    // stall these interval callbacks while the JSON is being parsed/stringified.
    await page.evaluate(() => {
      const monitor = { started: 0, finished: 0, beats: [] as number[] };
      (window as typeof window & { portfolioWorkerMonitor: typeof monitor }).portfolioWorkerMonitor = monitor;
      const nativePostMessage = Worker.prototype.postMessage;
      const nativeTerminate = Worker.prototype.terminate;
      Worker.prototype.postMessage = function (...args) {
        Reflect.apply(nativePostMessage, this, args);
        monitor.started = performance.now();
      };
      Worker.prototype.terminate = function () {
        monitor.finished = performance.now();
        nativeTerminate.call(this);
      };
      window.setInterval(() => monitor.beats.push(performance.now()), 10);
    });

    const workerUrls: string[] = [];
    page.on("worker", worker => workerUrls.push(worker.url()));
    const requests: Array<{ method: string; url: string; body: string | null }> = [];
    page.on("request", request => requests.push({
      method: request.method(),
      url: request.url(),
      body: request.postData(),
    }));

    const portfolio = `${'{"child":'.repeat(depth)}null${"}".repeat(depth)}`;
    // One unmatched closing brace forces the parser to traverse the entire deep payload.
    const text = `{"schemaVersion":"1.0","documentId":"${documentId}","exportedAt":"2026-09-22T00:00:00.000Z","portfolio":${portfolio},"integrity":{"algorithm":"SHA-256","checksum":"${"0".repeat(64)}","canonicalization":"teras-learner-portfolio-v1-json-stringify","verificationNote":"Integrity only."}}}`;
    assert(Buffer.byteLength(text) < maxFileSize, "Extreme JSON must stay below the 5 MiB limit");

    await page.getByTestId("input-portfolio-file").setInputFiles({
      name: "extreme-portfolio.json",
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
    const status = page.getByTestId("status-portfolio-verification");
    try {
      await status.getByRole("heading", { name: "File ditolak" }).waitFor({ timeout: 10_000 });
    } catch (error) {
      process.stderr.write(`Verification state: ${(await page.locator("body").innerText()).slice(-900)}; page errors: ${pageErrors.join("; ")}\n`);
      throw error;
    }
    await status.getByText("File tidak berisi JSON yang valid.").waitFor();

    const monitor = await page.evaluate(() =>
      (window as typeof window & { portfolioWorkerMonitor: { started: number; finished: number; beats: number[] } }).portfolioWorkerMonitor,
    );
    assert(workerUrls.some(url => /portfolio-verification\.worker/.test(url)),
      `No real bundled portfolio worker was created: ${workerUrls.join(", ")}`);
    assert(monitor.started > 0 && monitor.finished > monitor.started, "Worker did not receive and complete the verification job");
    const beatsDuringWork = monitor.beats.filter(beat => beat > monitor.started && beat < monitor.finished);
    assert(beatsDuringWork.length >= 2,
      `UI heartbeat did not advance twice while worker was active (${(monitor.finished - monitor.started).toFixed(1)} ms, ${beatsDuringWork.length} beats)`);
    const gaps = [monitor.started, ...beatsDuringWork, monitor.finished].slice(1)
      .map((beat, index) => beat - [monitor.started, ...beatsDuringWork][index]);
    assert(Math.max(...gaps) < 200, `UI heartbeat stalled for ${Math.max(...gaps).toFixed(1)} ms while worker was active`);
    assert(requests.every(request => ["GET", "HEAD"].includes(request.method)), "Verification sent a request with a body");
    assert(requests.every(request => !request.url.includes(documentId) && !request.body?.includes(documentId)),
      "Portfolio content was sent to the server");
    assert.deepEqual(pageErrors, [], `Browser errors: ${pageErrors.join("; ")}`);
    process.stdout.write(`browser portfolio worker responsiveness passed (${beatsDuringWork.length} beats during ${(monitor.finished - monitor.started).toFixed(1)} ms)\n`);
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});