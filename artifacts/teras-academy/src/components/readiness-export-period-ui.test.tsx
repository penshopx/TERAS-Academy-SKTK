import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReadinessAuditHistory } from "./admin/ReadinessAuditHistory";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
});

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <ReadinessAuditHistory enabled users={[]} pathways={[]} errorMessage={() => "Gagal"} />
  </QueryClientProvider>);
}

function installStalledProofFetch(onExport: () => void) {
  let proofSignal: AbortSignal | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/period-proof")) {
      proofSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }
    if (url.includes("/readiness-history/export") && !url.includes("export-trends")) {
      onExport();
      return new Response("Export unavailable", { status: 503 });
    }
    if (url.includes("/readiness-history/export-trends")) {
      return new Response("Unavailable", { status: 503 });
    }
    if (url.includes("/readiness-history")) {
      return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return () => proofSignal;
}

test("stalled period proof releases the export button and still starts the audit download", async () => {
  let exportRequests = 0;
  const proofSignal = installStalledProofFetch(() => { exportRequests++; });
  const view = renderHistory();
  fireEvent.click(view.getByTestId("button-export-readiness-history"));
  assert(view.getByTestId("readiness-export-progress"));
  await waitFor(() => assert.equal(exportRequests, 1), { timeout: 3_000 });
  assert.equal(proofSignal()?.aborted, true, "Timed-out proof request must be aborted");
  await waitFor(() => assert.equal((view.getByTestId("button-export-readiness-history") as HTMLButtonElement).disabled, false));
});

test("cancelling while period proof is stalled never starts an audit download", async () => {
  let exportRequests = 0;
  const proofSignal = installStalledProofFetch(() => { exportRequests++; });
  const view = renderHistory();
  fireEvent.click(view.getByTestId("button-export-readiness-history"));
  assert(view.getByTestId("readiness-export-progress"));
  fireEvent.click(view.getByTestId("button-cancel-readiness-export"));
  await waitFor(() => assert.equal((view.getByTestId("button-export-readiness-history") as HTMLButtonElement).disabled, false));
  assert.equal(proofSignal()?.aborted, true);
  assert.equal(exportRequests, 0, "Cancellation must not launch the export after proof acquisition stops");
});