import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { adminErrorMessage, filterQueueItems, getReminderDeliveryRefetchInterval, getReminderEscalationHistoryRefetchInterval, hasPermanentReminderEscalations, isAdminForbidden, isAdminMfaRequired, pendingReminderEscalationPageOffsets, queueStateFromSearch, ReminderEscalationHistory, reminderDeliveryPollingInterval, reminderEscalationStateFromSearch, shouldEnableAdminQueries, validateQueueFilters } from "../pages/admin";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

test("admin conflict errors provide an actionable accessible message", () => {
  assert.equal(
    adminErrorMessage({ status: 409, data: { error: "duplicate" } }),
    "Konflik: data sudah ada atau berubah. Muat ulang lalu coba lagi.",
  );
});

test("admin errors retain the API message when no conflict exists", () => {
  assert.equal(adminErrorMessage({ data: { error: "Tidak diizinkan" } }), "Tidak diizinkan");
});

test("admin forbidden response has a safe access-denied state", () => {
  assert.equal(isAdminForbidden({ status: 403 }), true);
  assert.equal(adminErrorMessage({ status: 403 }), "Anda tidak memiliki akses admin.");
});

test("admin MFA denial is distinguished from a missing role", () => {
  assert.equal(isAdminMfaRequired({ status: 403, data: { error: "Super administrator MFA (aal2) is required" } }), true);
  assert.equal(isAdminMfaRequired({ status: 403, data: { error: "Administrator role required" } }), false);
});

test("admin detail queries wait for a completed successful access gate", () => {
  assert.equal(shouldEnableAdminQueries({ isSuccess: false, isFetching: true }), false);
  assert.equal(shouldEnableAdminQueries({ isSuccess: true, isFetching: true, data: { authorized: true } }), false);
  assert.equal(shouldEnableAdminQueries({ isSuccess: false, isFetching: false, data: { authorized: true } }), false);
  assert.equal(shouldEnableAdminQueries({ isSuccess: true, isFetching: false, data: { authorized: true } }), true);
});

test("queue filters combine available operational context safely", () => {
  const items = [
    { id: "one", learnerId: "learner-a", pathwayId: "path-a", trainerId: "trainer-a", assessorId: null },
    { id: "two", learnerId: "learner-b", pathwayId: "path-b", trainerId: null, assessorId: "assessor-b" },
  ];
  assert.deepEqual(filterQueueItems(items, { learner: "learner-a", pathway: "path-a", trainer: "trainer-a", assessor: "unassigned" }).map(item => item.id), ["one"]);
  assert.deepEqual(filterQueueItems(items, { learner: "", pathway: "", trainer: "unassigned", assessor: "" }).map(item => item.id), ["two"]);
  assert.deepEqual(filterQueueItems(items, { learner: "unknown", pathway: "", trainer: "", assessor: "" }), []);
});

test("queue links restore the selected detail and filters from the URL", () => {
  const restored = queueStateFromSearch("?queue=remediation&learner=learner-a&trainer=unassigned");
  assert.deepEqual(restored, {
    selectedQueue: "remediation",
    filters: { learner: "learner-a", pathway: "", trainer: "unassigned", assessor: "" },
  });
  assert.deepEqual(validateQueueFilters([
    { learnerId: "learner-a", pathwayId: "path-a", trainerId: null, assessorId: "assessor-a" },
  ], restored.filters), restored.filters);
});

test("switching queues through the URL clears filters unavailable in the active queue", () => {
  const restored = queueStateFromSearch("?queue=assessment&learner=learner-from-remediation&trainer=trainer-a&assessor=unassigned");
  assert.deepEqual(validateQueueFilters([
    { learnerId: "learner-assessment", pathwayId: "path-a", trainerId: "trainer-a", assessorId: "assessor-a" },
  ], restored.filters), {
    learner: "",
    pathway: "",
    trainer: "trainer-a",
    assessor: "",
  });
});

test("stale or missing queue links clear the selected detail safely", () => {
  assert.deepEqual(queueStateFromSearch("?queue=unknown&assessor=assessor-a"), {
    selectedQueue: null,
    filters: { learner: "", pathway: "", trainer: "", assessor: "assessor-a" },
  });
  assert.deepEqual(queueStateFromSearch(""), {
    selectedQueue: null,
    filters: { learner: "", pathway: "", trainer: "", assessor: "" },
  });
});

test("only open permanent trainer reminder failures activate the admin alarm", () => {
  assert.equal(hasPermanentReminderEscalations({ failedTrainerReminders: [] }), false);
  assert.equal(hasPermanentReminderEscalations({ failedTrainerReminders: [{
    id: "delivery-1", trainerId: "trainer-1", trainerName: "Trainer Satu", target: "Inspeksi inverter",
    targetAt: "2030-01-10T00:00:00.000Z", lastAttemptAt: "2030-01-09T03:00:00.000Z", reason: "Layanan email tidak dapat menyelesaikan pengiriman.",
    emailNotification: null, webhookNotification: null, status: "open", resolution: null,
  }] }), true);
  assert.equal(hasPermanentReminderEscalations({ failedTrainerReminders: [{
    id: "delivery-2", trainerId: "trainer-1", trainerName: "Trainer Satu", target: "Inspeksi inverter",
    targetAt: "2030-01-10T00:00:00.000Z", lastAttemptAt: "2030-01-09T03:00:00.000Z", reason: "Layanan email tidak dapat menyelesaikan pengiriman.",
    emailNotification: null, webhookNotification: null, status: "resolved", resolution: { id: "resolution-1", reminderDeliveryId: "delivery-2", note: "Sudah dihubungi", resolvedByPersonId: "admin-1", resolvedAt: "2030-01-09T05:00:00.000Z" },
  }] }), false);
});

test("admin summary polls while a reminder notification delivery is still in progress", () => {
  const reminder = {
    id: "delivery-1", trainerId: "trainer-1", trainerName: "Trainer Satu", target: "Inspeksi inverter",
    targetAt: "2030-01-10T00:00:00.000Z", lastAttemptAt: "2030-01-09T03:00:00.000Z", reason: "Pengiriman belum selesai.",
    emailNotification: { status: "sent" as const, attemptedAt: "2030-01-09T03:00:00.000Z", sentAt: "2030-01-09T03:00:01.000Z", reason: null },
    webhookNotification: { status: "pending" as const, attemptedAt: null, sentAt: null, reason: null },
    status: "open" as const, resolution: null,
  };

  assert.equal(getReminderDeliveryRefetchInterval({ failedTrainerReminders: [reminder] }), reminderDeliveryPollingInterval);
  assert.equal(getReminderDeliveryRefetchInterval({
    failedTrainerReminders: [{
      ...reminder,
      webhookNotification: { ...reminder.webhookNotification, status: "sending" as const },
    }],
  }), reminderDeliveryPollingInterval);
});

test("admin summary stops polling after every reminder notification reaches a final status", () => {
  const reminder = {
    id: "delivery-1", trainerId: "trainer-1", trainerName: "Trainer Satu", target: "Inspeksi inverter",
    targetAt: "2030-01-10T00:00:00.000Z", lastAttemptAt: "2030-01-09T03:00:00.000Z", reason: "Pengiriman selesai diproses.",
    emailNotification: { status: "sent" as const, attemptedAt: "2030-01-09T03:00:00.000Z", sentAt: "2030-01-09T03:00:01.000Z", reason: null },
    webhookNotification: { status: "failed" as const, attemptedAt: "2030-01-09T03:00:00.000Z", sentAt: null, reason: "Endpoint tidak tersedia." },
    status: "open" as const, resolution: null,
  };

  assert.equal(getReminderDeliveryRefetchInterval({ failedTrainerReminders: [reminder] }), false);
  assert.equal(getReminderDeliveryRefetchInterval({ failedTrainerReminders: [] }), false);
  assert.equal(getReminderDeliveryRefetchInterval(undefined), false);
});

const escalation = (id: string, status: "open" | "resolved") => ({
  id,
  trainerId: "trainer-1",
  trainerName: `Trainer ${id}`,
  target: `Target ${id}`,
  targetAt: "2030-01-10T00:00:00.000Z",
  lastAttemptAt: "2030-01-09T03:00:00.000Z",
  reason: `Alasan ${id}`,
  emailNotification: null,
  webhookNotification: null,
  status,
  resolution: null,
});

test("history polls only for visible pending or sending channels", () => {
  const page = (offset: number, emailStatus: "pending" | "sending" | "sent" | "failed") => ({
    items: [{ ...escalation(`item-${offset}`, "open"), emailNotification: { status: emailStatus, attemptedAt: null, sentAt: null, reason: null } }],
    pagination: { offset, returned: 1, total: 2, hasMore: offset === 0 },
    counts: { open: 2, resolved: 0, total: 2 },
  });
  assert.equal(getReminderEscalationHistoryRefetchInterval(undefined, 0), false);
  assert.equal(getReminderEscalationHistoryRefetchInterval({ pages: [page(0, "pending")] }, 0), reminderDeliveryPollingInterval);
  assert.equal(getReminderEscalationHistoryRefetchInterval({ pages: [page(0, "sending")] }, 0), reminderDeliveryPollingInterval);
  assert.equal(getReminderEscalationHistoryRefetchInterval({ pages: [page(0, "sent"), page(1, "pending")] }, 0), false);
  assert.equal(getReminderEscalationHistoryRefetchInterval({ pages: [page(0, "sent"), page(1, "pending")] }, 1), reminderDeliveryPollingInterval);
  assert.equal(getReminderEscalationHistoryRefetchInterval({ pages: [page(0, "sent"), page(1, "failed")] }, 1), false);
});

test("history refreshes a temporary channel status and keeps loaded pages after final status", async () => {
  const requests: number[] = [];
  const loadPage = async (params?: { offset?: number }) => {
    const offset = params?.offset ?? 0;
    requests.push(offset);
    const firstPageRefetch = requests.filter(value => value === 0).length > 1;
    return {
      items: offset === 0
        ? [{ ...escalation("one", "open"), emailNotification: { status: firstPageRefetch ? "sent" as const : "pending" as const, attemptedAt: null, sentAt: null, reason: null } }]
        : [escalation("one", "open"), escalation("two", "open")],
      pagination: { offset, limit: 25, returned: offset === 0 ? 1 : 2, total: 2, hasMore: offset === 0 },
      counts: { open: 2, resolved: 0, total: 2 },
    };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ReminderEscalationHistory enabled onResolve={() => undefined} loadPage={loadPage} pollInterval={30} />
    </QueryClientProvider>,
  );

  await waitFor(() => assert.match(view.getByTestId("reminder-escalation-one").textContent ?? "", /Menunggu/));
  fireEvent.click(view.getByTestId("button-load-more-reminder-escalations"));
  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-two")));
  const cachedHistory = () => queryClient.getQueryCache().getAll()[0]?.state.data as Parameters<typeof getReminderEscalationHistoryRefetchInterval>[0];
  assert.equal(getReminderEscalationHistoryRefetchInterval(cachedHistory(), 1), reminderDeliveryPollingInterval);
  await waitFor(() => assert.match(view.getByTestId("reminder-escalation-one").textContent ?? "", /Terkirim/));
  assert.equal(view.getAllByTestId("reminder-escalation-one").length, 1);
  assert.ok(view.getByTestId("reminder-escalation-two"));
  assert.deepEqual(requests, [0, 1, 0]);
  assert.equal(getReminderEscalationHistoryRefetchInterval(cachedHistory(), 1), false);
  view.unmount();
  queryClient.clear();
});

test("polling several pages requests only visible unfinished pages and preserves history order", async () => {
  const requests: number[] = [];
  const notification = (status: "pending" | "sending" | "sent" | "failed") => ({
    status, attemptedAt: null, sentAt: null, reason: null,
  });
  const row = (id: string, status?: "pending" | "sending" | "sent" | "failed") => ({
    ...escalation(id, "open"),
    emailNotification: status ? notification(status) : null,
  });
  const loadPage = async (params?: { offset?: number }) => {
    const offset = params?.offset ?? 0;
    requests.push(offset);
    const calls = requests.filter(value => value === offset).length;
    const items = offset === 0 ? [row("one")] : offset === 2
      ? calls === 1 ? [row("two", "pending"), row("three")] : [row("new", "sent"), row("three"), row("two", "sent")]
      : calls === 1 ? [row("four", "sending"), row("five")] : [row("five"), row("four", "failed")];
    return {
      items,
      pagination: { offset, limit: 25, returned: 2, total: 5, hasMore: offset < 4 },
      counts: { open: 5, resolved: 0, total: 5 },
    };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ReminderEscalationHistory enabled onResolve={() => undefined} loadPage={loadPage} pollInterval={80} />
    </QueryClientProvider>,
  );
  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-one")));
  fireEvent.click(view.getByTestId("button-load-more-reminder-escalations"));
  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-two")));
  fireEvent.click(view.getByTestId("button-load-more-reminder-escalations"));
  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-four")));
  assert.deepEqual(requests, [0, 2, 4]);
  const cache = () => queryClient.getQueryCache().getAll()[0]?.state.data as Parameters<typeof pendingReminderEscalationPageOffsets>[0];
  assert.deepEqual(pendingReminderEscalationPageOffsets(cache(), 2), [2]);
  assert.deepEqual(pendingReminderEscalationPageOffsets(cache(), 4), [2, 4]);
  await waitFor(() => assert.match(view.getByTestId("reminder-escalation-two").textContent ?? "", /Terkirim/));
  await waitFor(() => assert.match(view.getByTestId("reminder-escalation-four").textContent ?? "", /Gagal/));
  assert.deepEqual(requests, [0, 2, 4, 2, 4]);
  assert.deepEqual(Array.from(view.container.querySelectorAll("[data-testid^='reminder-escalation-']")).filter(element => element.tagName === "ARTICLE").map(element => element.getAttribute("data-testid")), [
    "reminder-escalation-one", "reminder-escalation-two", "reminder-escalation-three", "reminder-escalation-four", "reminder-escalation-five",
  ]);
  assert.equal(view.queryByTestId("reminder-escalation-new"), null);
  assert.equal(view.getAllByTestId("reminder-escalation-two").length, 1);
  assert.deepEqual(pendingReminderEscalationPageOffsets(cache(), 4), []);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(requests, [0, 2, 4, 2, 4]);
  view.unmount();
  queryClient.clear();
});

test("reminder escalation filters and pagination drive API requests and rendered history", async () => {
  const firstPage = {
    items: [escalation("one", "open"), escalation("two", "open")],
    pagination: { offset: 0, limit: 25, returned: 2, total: 3, hasMore: true },
    counts: { open: 3, resolved: 4, total: 7 },
  };
  const lastPage = {
    items: [escalation("two", "open"), escalation("three", "open")],
    pagination: { offset: 2, limit: 25, returned: 2, total: 3, hasMore: false },
    counts: { open: 3, resolved: 4, total: 7 },
  };
  const resolvedPage = {
    items: [escalation("resolved-one", "resolved")],
    pagination: { offset: 0, limit: 25, returned: 1, total: 4, hasMore: true },
    counts: { open: 3, resolved: 4, total: 7 },
  };
  const requests: Array<{ status?: string; limit?: number; offset?: number }> = [];
  const loadPage = async (params?: { status?: "open" | "resolved"; limit?: number; offset?: number }) => {
    requests.push(params ?? {});
    if (params?.status === "resolved") return resolvedPage;
    return params?.offset === 2 ? lastPage : firstPage;
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ReminderEscalationHistory enabled onResolve={() => undefined} loadPage={loadPage} />
    </QueryClientProvider>,
  );

  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-one")));
  assert.deepEqual(requests[0], { status: "open", limit: 25, offset: 0 });
  assert.match(view.getByTestId("reminder-escalation-total").textContent ?? "", /7 total/);
  assert.match(view.getByText(/Menampilkan 2 dari 3 eskalasi terbuka/).textContent ?? "", /2 dari 3/);

  fireEvent.click(view.getByTestId("button-load-more-reminder-escalations"));
  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-three")));
  assert.deepEqual(requests[1], { status: "open", limit: 25, offset: 2 });
  assert.equal(window.location.search, "?escalationStatus=open&escalationOffset=2");
  const sharedSearch = window.location.search;
  assert.equal(view.getAllByTestId("reminder-escalation-two").length, 1);
  assert.equal(view.queryByTestId("button-load-more-reminder-escalations"), null);
  assert.match(view.getByText(/Menampilkan 3 dari 3 eskalasi terbuka/).textContent ?? "", /3 dari 3/);

  fireEvent.click(view.getByTestId("filter-reminder-escalations-resolved"));
  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-resolved-one")));
  assert.deepEqual(requests[2], { status: "resolved", limit: 25, offset: 0 });
  assert.equal(window.location.search, "?escalationStatus=resolved");
  assert.equal(view.queryByTestId("reminder-escalation-one"), null);
  assert.match(view.getByTestId("reminder-escalation-total").textContent ?? "", /7 total/);
  assert.match(view.getByText(/Menampilkan 1 dari 4 eskalasi selesai/).textContent ?? "", /1 dari 4/);

  fireEvent.click(view.getByTestId("filter-reminder-escalations-open"));
  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-one")));
  assert.equal(view.getByTestId("filter-reminder-escalations-open").getAttribute("aria-pressed"), "true");
  assert.equal(view.getByTestId("filter-reminder-escalations-resolved").getAttribute("aria-pressed"), "false");

  view.unmount();
  window.history.replaceState({}, "", `/admin${sharedSearch}`);
  const sharedView = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReminderEscalationHistory enabled onResolve={() => undefined} loadPage={loadPage} />
    </QueryClientProvider>,
  );
  await waitFor(() => assert.ok(sharedView.getByTestId("reminder-escalation-three")));
  assert.ok(sharedView.getByTestId("reminder-escalation-one"));
  assert.equal(sharedView.getAllByTestId("reminder-escalation-two").length, 1);
  assert.deepEqual(requests.slice(-2), [
    { status: "open", limit: 25, offset: 0 },
    { status: "open", limit: 25, offset: 2 },
  ]);
});

test("failed escalation page preserves history, filter and totals until retry appends it once", async () => {
  const requests: Array<{ status?: string; limit?: number; offset?: number }> = [];
  let secondPageAttempts = 0;
  const loadPage = async (params?: { status?: "open" | "resolved"; limit?: number; offset?: number }) => {
    requests.push(params ?? {});
    if (params?.offset === 2) {
      secondPageAttempts++;
      if (secondPageAttempts === 1) throw new Error("Layanan sementara tidak tersedia");
      return {
        items: [escalation("two", "open"), escalation("three", "open")],
        pagination: { offset: 2, limit: 25, returned: 2, total: 3, hasMore: false },
        counts: { open: 3, resolved: 4, total: 7 },
      };
    }
    return {
      items: [escalation("one", "open"), escalation("two", "open")],
      pagination: { offset: 0, limit: 25, returned: 2, total: 3, hasMore: true },
      counts: { open: 3, resolved: 4, total: 7 },
    };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ReminderEscalationHistory enabled onResolve={() => undefined} loadPage={loadPage} />
    </QueryClientProvider>,
  );

  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-one")));
  fireEvent.click(view.getByTestId("button-load-more-reminder-escalations"));
  await waitFor(() => assert.match(view.getByTestId("reminder-escalation-page-error").textContent ?? "", /Gagal memuat halaman berikutnya/));
  assert.equal(view.getByTestId("reminder-escalation-one").textContent?.includes("Target one"), true);
  assert.equal(view.getAllByTestId("reminder-escalation-two").length, 1);
  assert.equal(view.queryByTestId("reminder-escalation-three"), null);
  assert.equal(view.getByTestId("filter-reminder-escalations-open").getAttribute("aria-pressed"), "true");
  assert.match(view.getByTestId("reminder-escalation-total").textContent ?? "", /7 total/);
  assert.match(view.getByText(/Menampilkan 2 dari 3 eskalasi terbuka/).textContent ?? "", /2 dari 3/);
  assert.equal(window.location.search, "");
  assert.match(view.getByTestId("button-load-more-reminder-escalations").textContent ?? "", /Coba lagi/);

  fireEvent.click(view.getByTestId("button-load-more-reminder-escalations"));
  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-three")));
  assert.equal(view.queryByTestId("reminder-escalation-page-error"), null);
  assert.equal(view.getAllByTestId("reminder-escalation-two").length, 1);
  assert.match(view.getByText(/Menampilkan 3 dari 3 eskalasi terbuka/).textContent ?? "", /3 dari 3/);
  assert.equal(view.getByTestId("filter-reminder-escalations-open").getAttribute("aria-pressed"), "true");
  assert.match(view.getByTestId("reminder-escalation-total").textContent ?? "", /7 total/);
  assert.equal(window.location.search, "?escalationStatus=open&escalationOffset=2");
  assert.deepEqual(requests, [
    { status: "open", limit: 25, offset: 0 },
    { status: "open", limit: 25, offset: 2 },
    { status: "open", limit: 25, offset: 2 },
  ]);
  view.unmount();
  queryClient.clear();
});

test("failed shared escalation page waits for an explicit retry instead of looping", async () => {
  window.history.replaceState({}, "", "/admin?escalationStatus=resolved&escalationOffset=2");
  const requests: number[] = [];
  const loadPage = async (params?: { offset?: number }) => {
    const offset = params?.offset ?? 0;
    requests.push(offset);
    if (offset === 2 && requests.filter(value => value === 2).length === 1) throw new Error("Sementara gagal");
    return {
      items: offset === 0 ? [escalation("resolved-one", "resolved")] : [escalation("resolved-two", "resolved")],
      pagination: { offset, limit: 25, returned: offset === 0 ? 2 : 1, total: 3, hasMore: offset === 0 },
      counts: { open: 4, resolved: 3, total: 7 },
    };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ReminderEscalationHistory enabled onResolve={() => undefined} loadPage={loadPage} />
    </QueryClientProvider>,
  );

  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-page-error")));
  assert.deepEqual(requests, [0, 2]);
  assert.ok(view.getByTestId("reminder-escalation-resolved-one"));
  assert.equal(view.getByTestId("filter-reminder-escalations-resolved").getAttribute("aria-pressed"), "true");
  assert.match(view.getByTestId("reminder-escalation-total").textContent ?? "", /7 total/);
  fireEvent.click(view.getByTestId("button-load-more-reminder-escalations"));
  await waitFor(() => assert.ok(view.getByTestId("reminder-escalation-resolved-two")));
  assert.deepEqual(requests, [0, 2, 2]);
  assert.equal(view.queryByTestId("reminder-escalation-page-error"), null);
  assert.equal(view.getAllByTestId("reminder-escalation-resolved-one").length, 1);
  assert.equal(window.location.search, "?escalationStatus=resolved&escalationOffset=2");
  view.unmount();
  queryClient.clear();
});

test("shared reminder escalation links restore status and page without changing audit details", async () => {
  window.history.replaceState({}, "", "/admin?escalationStatus=resolved&escalationOffset=25");
  const resolution = { id: "resolution-1", reminderDeliveryId: "resolved-one", note: "Sudah dihubungi", resolvedByPersonId: "admin-1", resolvedAt: "2030-01-09T05:00:00.000Z" };
  const requests: Array<{ status?: string; offset?: number }> = [];
  const loadPage = async (params?: { status?: "open" | "resolved"; limit?: number; offset?: number }) => {
    requests.push(params ?? {});
    return {
      items: params?.offset === 25
        ? [{ ...escalation("resolved-one", "resolved"), resolution }]
        : [escalation("resolved-zero", "resolved")],
      pagination: { offset: params?.offset ?? 0, limit: 25, returned: params?.offset === 0 ? 25 : 1, total: 26, hasMore: params?.offset === 0 },
      counts: { open: 3, resolved: 4, total: 7 },
    };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ReminderEscalationHistory enabled onResolve={() => undefined} loadPage={loadPage} />
    </QueryClientProvider>,
  );

  await waitFor(() => assert.ok(view.getByTestId("reminder-resolution-resolved-one")));
  assert.deepEqual(requests, [
    { status: "resolved", limit: 25, offset: 0 },
    { status: "resolved", limit: 25, offset: 25 },
  ]);
  assert.ok(view.getByTestId("reminder-escalation-resolved-zero"));
  assert.match(view.getByTestId("reminder-escalation-total").textContent ?? "", /7 total/);
  assert.match(view.getByTestId("reminder-resolution-resolved-one").textContent ?? "", /Sudah dihubungi/);

  window.history.pushState({}, "", "/admin?escalationStatus=open");
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  await waitFor(() => assert.equal(view.getByTestId("filter-reminder-escalations-open").getAttribute("aria-pressed"), "true"));
  assert.deepEqual(requests[2], { status: "open", limit: 25, offset: 0 });
});

test("invalid reminder escalation URL state falls back safely", () => {
  assert.deepEqual(reminderEscalationStateFromSearch("?escalationStatus=unknown&escalationOffset=-1"), { status: "open", offset: 0 });
  assert.deepEqual(reminderEscalationStateFromSearch("?escalationStatus=resolved&escalationOffset=50"), { status: "resolved", offset: 50 });
});

test("admin summary renders every safe permanent-failure detail for the manager", async () => {
  const source = await readFile(new URL("../pages/admin.tsx", import.meta.url), "utf8");
  assert.match(source, /data-testid="admin-failed-trainer-reminders"/);
  assert.match(source, /item\.trainerName/);
  assert.match(source, /item\.target/);
  assert.match(source, /item\.lastAttemptAt/);
  assert.match(source, /item\.reason/);
  assert.match(source, /Email pengelola/);
  assert.match(source, /Webhook cadangan/);
  assert.match(source, /item\.emailNotification/);
  assert.match(source, /item\.webhookNotification/);
  assert.doesNotMatch(source, /failureNotification\.destination/);
  assert.match(source, /useResolveAdminReminderEscalation/);
  assert.match(source, /useInfiniteQuery/);
  assert.match(source, /listAdminReminderEscalations/);
  assert.match(source, /filter-reminder-escalations-open/);
  assert.match(source, /filter-reminder-escalations-resolved/);
  assert.match(source, /button-load-more-reminder-escalations/);
  assert.match(source, /reminder-escalation-total/);
  assert.match(source, /whitespace-pre-wrap break-words/);
  assert.match(source, /input-reminder-resolution-note/);
  assert.match(source, /admin-reminder-escalation-history/);
});

test("admin programme catalogue separates canonical modules from read-only legacy mappings", async () => {
  const source = await readFile(new URL("../pages/admin.tsx", import.meta.url), "utf8");
  assert.match(source, /useGetAdminModuleCatalogue/);
  assert.match(source, /Baseline canonical aktif/);
  assert.match(source, /Catatan legacy yang dihentikan/);
  assert.match(source, /bukan kurikulum aktif/);
  assert.match(source, /mapping hilang/);
  assert.match(source, /mapping tidak lengkap/);
  assert.match(source, /Target canonical tidak tersedia/);
});
