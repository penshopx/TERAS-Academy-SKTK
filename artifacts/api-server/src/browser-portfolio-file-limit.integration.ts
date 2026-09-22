import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import { chromium } from "playwright";
import { BrowserTestIdentityHarness } from "./browser-test-identity-harness.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const replitChromiumPath = "/repl/tools/bin/chromium";
const maximumPortfolioFileSize = 5 * 1024 * 1024;

function chromiumExecutablePath() {
  const configuredPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configuredPath) return configuredPath;
  return existsSync(replitChromiumPath) ? replitChromiumPath : undefined;
}

async function main() {
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    await execFileAsync(
      "pnpm",
      ["--filter", "@workspace/teras-academy", "exec", "vite", "build", "--config", "vite.config.ts"],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: "test",
          BASE_PATH: "/",
          PORT: "4173",
        },
      },
    );

    const appServer = express();
    appServer.get("/api/session", (_request, response) => response.status(401).json({ message: "Signed out" }));
    appServer.get("/api/*path", (_request, response) => response.json([]));
    const frontend = path.join(root, "artifacts/teras-academy/dist/public");
    appServer.use(express.static(frontend));
    appServer.get(/.*/, (_request, response) => response.sendFile(path.join(frontend, "index.html")));
    server = appServer.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not determine portfolio verifier browser test server address.");

    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutablePath() });
    const { page } = await BrowserTestIdentityHarness.createPage(browser, "portfolio-verifier");
    page.on("console", message => {
      if (message.type() === "error") process.stderr.write(`[browser console] ${message.text()}\n`);
    });
    page.on("pageerror", error => process.stderr.write(`[browser pageerror] ${error.message}\n`));

    await page.goto(`http://127.0.0.1:${address.port}/verify-portfolio`);
    await page.getByRole("heading", { name: "Verifikasi file portfolio" }).waitFor();

    const fileInput = page.getByTestId("input-portfolio-file");
    const oversizedFile = Buffer.alloc(maximumPortfolioFileSize + 1, 0x20);
    await fileInput.setInputFiles({
      name: "portfolio-too-large.json",
      mimeType: "application/json",
      buffer: oversizedFile,
    });

    const status = page.getByTestId("status-portfolio-verification");
    await status.getByRole("heading", { name: "File ditolak" }).waitFor();
    await status.getByText("Ukuran file melebihi batas 5 MiB.", { exact: false }).waitFor();
    if (await fileInput.isDisabled()) throw new Error("The portfolio file picker stayed disabled after rejecting an oversized file.");
    if (await fileInput.inputValue() !== "") throw new Error("The portfolio file picker did not reset after rejecting an oversized file.");

    await fileInput.setInputFiles({
      name: "portfolio-too-large-again.json",
      mimeType: "application/json",
      buffer: oversizedFile,
    });
    await page.getByTestId("text-selected-file").getByText("portfolio-too-large-again.json", { exact: false }).waitFor();
    await status.getByRole("heading", { name: "File ditolak" }).waitFor();
    await status.getByText("Ukuran file melebihi batas 5 MiB.", { exact: false }).waitFor();

    process.stdout.write("browser portfolio file limit integration passed\n");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});