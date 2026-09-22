/// <reference lib="webworker" />

import { verifyPortfolioText } from "./portfolio-verification";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", async event => {
  const result = await verifyPortfolioText(event.data);
  self.postMessage(result);
});
