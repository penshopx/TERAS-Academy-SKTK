import { inArray } from "drizzle-orm";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { get, ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  db, enrollmentsTable, pathwaysTable, peopleTable, programsTable, readinessEventsTable, readinessGatesTable,
} from "@workspace/db";
import { createIntegrationTestApp } from "./integration-test-app";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const suffix = crypto.randomUUID();
const id = (label: string) => `readiness-audit-${label}-${suffix}`;
const ids = {
  learnerA: id("learner-a"), learnerB: id("learner-b"), program: id("program"),
  pathwayA: id("path-a"), pathwayB: id("path-b"), enrollmentA: id("enrollment-a"),
  enrollmentB: id("enrollment-b"), gateA: id("gate-a"), gateB: id("gate-b"),
  eventA: id("event-a"), eventB: id("event-b"), eventC: id("event-c"),
};
const volumeEventIds = Array.from({ length: 1_205 }, (_, index) => id(`volume-${String(index).padStart(4, "0")}`));
const execFileAsync = promisify(execFile);

async function insertInBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>, batchSize = 200) {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await insert(rows.slice(offset, offset + batchSize));
  }
}

async function slowRequest(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string; backpressureCount: number; maxBufferedBytes: number; highWaterMark: number }>((resolve, reject) => {
    let backpressureCount = 0;
    let maxBufferedBytes = 0;
    let highWaterMark = 0;
    const originalWrite = ServerResponse.prototype.write;
    ServerResponse.prototype.write = function (this: ServerResponse, ...args: any[]) {
      const accepted = originalWrite.apply(this, args as any);
      if (!accepted) backpressureCount += 1;
      maxBufferedBytes = Math.max(maxBufferedBytes, this.writableLength);
      highWaterMark = Math.max(highWaterMark, this.writableHighWaterMark);
      return accepted;
    } as typeof originalWrite;

    const request = get(url, { headers }, response => {
      const chunks: Buffer[] = [];
      response.pause();
      setTimeout(() => {
        response.on("data", chunk => {
          chunks.push(Buffer.from(chunk));
          response.pause();
          setTimeout(() => response.resume(), 1);
        });
        response.on("end", () => {
          ServerResponse.prototype.write = originalWrite;
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            backpressureCount,
            maxBufferedBytes,
            highWaterMark,
          });
        });
        response.resume();
      }, 100);
    });
    request.on("error", error => {
      ServerResponse.prototype.write = originalWrite;
      reject(error);
    });
  });
}

async function run() {
  const activeKeyPair = generateKeyPairSync("ed25519");
  const retiredKeyPair = generateKeyPairSync("ed25519");
  const publicPem = activeKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = activeKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const retiredPublicPem = retiredKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.TERAS_READINESS_AUDIT_SIGNING_KEYS = JSON.stringify([
    { keyId: "teras-audit-2026-09", version: 2, active: true, publicKeyPem: publicPem, privateKeyPem: privatePem },
    { keyId: "teras-audit-2026-01", version: 1, active: false, publicKeyPem: retiredPublicPem },
  ]);
  await db.insert(peopleTable).values([
    { id: ids.learnerA, name: "Audit Learner A", initials: "AA", role: "learner", status: "active" },
    { id: ids.learnerB, name: "Audit Learner B", initials: "AB", role: "learner", status: "active" },
  ]);
  await db.insert(programsTable).values({ id: ids.program, domain: "Audit", name: "Audit", description: "Audit test", status: "active" });
  await db.insert(pathwaysTable).values([
    { id: ids.pathwayA, programId: ids.program, name: "Audit Path A", type: "test", outcome: "test" },
    { id: ids.pathwayB, programId: ids.program, name: "Audit Path B", type: "test", outcome: "test" },
  ]);
  await db.insert(enrollmentsTable).values([
    { id: ids.enrollmentA, learnerId: ids.learnerA, programId: ids.program, pathwayId: ids.pathwayA },
    { id: ids.enrollmentB, learnerId: ids.learnerB, programId: ids.program, pathwayId: ids.pathwayB },
  ]);
  await db.insert(readinessGatesTable).values([
    { id: ids.gateA, programId: ids.program, pathwayId: ids.pathwayA, sequence: 1, code: "A1", name: "Audit Gate A", requirement: "A", ruleVersion: 2 },
    { id: ids.gateB, programId: ids.program, pathwayId: ids.pathwayB, sequence: 1, code: "B1", name: "Audit Gate B", requirement: "B", ruleVersion: 3 },
  ]);
  await db.insert(readinessEventsTable).values([
    {
      id: ids.eventA, enrollmentId: ids.enrollmentA, pathwayId: ids.pathwayA, gateId: ids.gateA,
      status: "Developing", score: 72, blockers: ["Evidence pending"], ruleVersion: 2,
      inputEvidence: { assessments: [{ id: "assessment-a", score: 72, completed: true, criticalFailure: false }], evidence: [{ requirementId: "evidence-a", satisfied: false }], openCriticalGaps: [] },
      decisionReason: "Evidence is incomplete", evaluatedAt: new Date("2026-01-01T10:00:00Z"),
    },
    {
      id: ids.eventB, enrollmentId: ids.enrollmentB, pathwayId: ids.pathwayB, gateId: ids.gateB,
      status: "Not Ready", score: 40, blockers: ["Critical safety"], ruleVersion: 3,
      inputEvidence: { assessments: [{ id: "assessment-b", score: 40, completed: true, criticalFailure: true }], evidence: [], openCriticalGaps: ["gap-b"] },
      decisionReason: "Critical safety failure", evaluatedAt: new Date("2026-01-02T10:00:00Z"),
    },
    {
      id: ids.eventC, enrollmentId: ids.enrollmentB, pathwayId: ids.pathwayB, gateId: ids.gateB,
      status: "Not Ready", score: 45, blockers: ["Critical safety"], ruleVersion: 3,
      inputEvidence: { assessments: [], evidence: [], openCriticalGaps: ["gap-c"] },
      decisionReason: "Critical gap remains open", evaluatedAt: new Date("2026-01-02T10:00:00Z"),
    },
  ]);

  const app = createIntegrationTestApp(req => {
    const role = req.get("x-test-role");
    return { userId: `${role ?? "anonymous"}-readiness-audit`, role: role === "admin" ? "admin" : role === "learner" ? "learner" : null };
  });
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Test server did not bind");
  const request = (path: string, role: "admin" | "learner") => fetch(`http://127.0.0.1:${address.port}/api${path}`, { headers: { "x-test-role": role } });

  try {
    const forbidden = await request("/admin/readiness-history", "learner");
    assert(forbidden.status === 403, "Learners must not access readiness audit history");

    const filteredResponse = await request(`/admin/readiness-history?learnerId=${ids.learnerA}&pathwayId=${ids.pathwayA}&status=Developing&ruleVersion=2&page=1&pageSize=1`, "admin");
    const filtered = await filteredResponse.json() as any;
    assert(filteredResponse.status === 200 && filtered.items.length === 1, "All readiness history filters must be applied together");
    assert(filtered.total === 1 && filtered.page === 1 && filtered.pageSize === 1, "History must report accurate pagination metadata");
    assert(filtered.items[0].id === ids.eventA && filtered.items[0].learnerName === "Audit Learner A", "Filtered history must preserve learner context");
    assert(filtered.items[0].inputEvidence.evidence[0].requirementId === "evidence-a", "History must include the immutable evidence snapshot");

    const firstPageResponse = await request("/admin/readiness-history?page=1&pageSize=1", "admin");
    const firstPage = await firstPageResponse.json() as any;
    assert(firstPage.items.length === 1 && firstPage.total >= 2, "Page size must bound records without changing the total");

    const secondPageResponse = await request("/admin/readiness-history?page=2&pageSize=1", "admin");
    const secondPage = await secondPageResponse.json() as any;
    assert(secondPage.items.length === 1 && secondPage.items[0].id !== firstPage.items[0].id, "Distinct pages must return distinct readiness events");

    const exportResponse = await request(`/admin/readiness-history/export?status=Not%20Ready&ruleVersion=3`, "admin");
    const exported = await exportResponse.json() as any;
    assert(exportResponse.status === 200 && exportResponse.headers.get("cache-control") === "private, no-store", "Audit export must be private and non-cacheable");
    assert(exported.schemaVersion === "1.0" && exported.recordCount === 2, "Export must be versioned and report its record count");
    assert(exported.records.some((record: any) => record.id === ids.eventB && record.inputEvidence.openCriticalGaps[0] === "gap-b"), "Export must include complete decision snapshots");
    assert(exported.records.some((record: any) => record.id === ids.eventC), "Export must preserve records with identical evaluation timestamps");
    const canonicalPayload = {
      schemaVersion: exported.schemaVersion,
      exportedAt: exported.exportedAt,
      filters: exported.filters,
      recordCount: exported.recordCount,
      records: exported.records,
    };
    const canonicalJson = JSON.stringify(canonicalPayload);
    const checksum = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
    assert(exported.integrity.algorithm === "SHA-256" && exported.integrity.checksum === checksum, "Export checksum must verify its canonical payload");
    assert(exported.integrity.signature.algorithm === "Ed25519"
      && exported.integrity.signature.keyId === "teras-audit-2026-09"
      && exported.integrity.signature.keyVersion === 2, "Export signature must identify the active versioned key");
    assert(verify(null, Buffer.from(checksum, "hex"), activeKeyPair.publicKey, Buffer.from(exported.integrity.signature.value, "base64")), "Export signature must verify over the canonical checksum");
    const publicKeysResponse = await request("/readiness-audit/public-keys", "learner");
    const publicKeys = await publicKeysResponse.json() as any;
    assert(publicKeysResponse.status === 200 && publicKeys.issuer === "TERAS", "Public verification keys must be available without admin authorization");
    assert(publicKeys.keys.length === 2 && publicKeys.keys[0].version === 2 && publicKeys.keys[1].version === 1, "Public key history must retain key IDs and versions across rotation");
    assert(!JSON.stringify(publicKeys).includes("PRIVATE KEY"), "Public key endpoint must never expose private key material");
    const changedByte = canonicalJson.replace("Critical gap remains open", "Critical gap remains opfn");
    assert(changedByte.length === canonicalJson.length && changedByte !== canonicalJson, "Checksum fixture must change exactly one byte");
    const changedChecksum = createHash("sha256").update(changedByte, "utf8").digest("hex");
    assert(changedChecksum !== exported.integrity.checksum, "Changing one canonical payload byte must fail checksum verification");
    const verifierDirectory = await mkdtemp(join(tmpdir(), "teras-readiness-verifier-"));
    const verifierPath = new URL("../scripts/verify-readiness-audit.mjs", import.meta.url);
    const keysPath = join(verifierDirectory, "public-keys.json");
    const exportPath = join(verifierDirectory, "export.json");
    await writeFile(keysPath, JSON.stringify(publicKeys));
    const runVerifier = async (document: any) => {
      await writeFile(exportPath, JSON.stringify(document));
      try {
        await execFileAsync(process.execPath, [verifierPath.pathname, exportPath, keysPath]);
        return true;
      } catch {
        return false;
      }
    };
    assert(await runVerifier(exported), "Official verifier must accept an authentic export");
    const payloadTampered = structuredClone(exported);
    payloadTampered.records[0].decisionReason = `${payloadTampered.records[0].decisionReason} changed`;
    assert(!await runVerifier(payloadTampered), "Official verifier must reject a modified payload");
    const checksumTampered = structuredClone(exported);
    checksumTampered.integrity.checksum = `${checksumTampered.integrity.checksum.slice(0, -1)}${checksumTampered.integrity.checksum.endsWith("0") ? "1" : "0"}`;
    assert(!await runVerifier(checksumTampered), "Official verifier must reject a modified checksum");
    const signatureTampered = structuredClone(exported);
    const signatureBytes = Buffer.from(signatureTampered.integrity.signature.value, "base64");
    signatureBytes[0] ^= 1;
    signatureTampered.integrity.signature.value = signatureBytes.toString("base64");
    assert(!await runVerifier(signatureTampered), "Official verifier must reject a modified signature");
    await rm(verifierDirectory, { recursive: true, force: true });

    const sharedTimestamps = [
      new Date("2026-02-03T10:00:00Z"),
      new Date("2026-02-02T10:00:00Z"),
      new Date("2026-02-01T10:00:00Z"),
    ];
    const volumeEvents = volumeEventIds.map((eventId, index) => ({
      id: eventId,
      enrollmentId: ids.enrollmentA,
      pathwayId: ids.pathwayA,
      gateId: ids.gateA,
      status: "Developing" as const,
      score: 70 + (index % 10),
      blockers: [`Volume blocker ${index}`],
      ruleVersion: 2,
      inputEvidence: { assessments: [], evidence: [], openCriticalGaps: [] },
      decisionReason: `Volume decision ${index}`,
      evaluatedAt: sharedTimestamps[index % sharedTimestamps.length],
    }));
    await insertInBatches(volumeEvents, batch => db.insert(readinessEventsTable).values(batch));

    const originalWrite = ServerResponse.prototype.write;
    const volumeUrl = `http://127.0.0.1:${address.port}/api/admin/readiness-history/export?learnerId=${ids.learnerA}&pathwayId=${ids.pathwayA}&status=Developing&ruleVersion=2`;
    const slowExport = await slowRequest(volumeUrl, { "x-test-role": "admin" });
    assert(ServerResponse.prototype.write === originalWrite, "Slow-client response instrumentation must be restored");
    assert(slowExport.status === 200, "Large readiness export must succeed for a slow client");
    const volumeExport = JSON.parse(slowExport.body) as any;
    const volumeEventById = new Map(volumeEvents.map(event => [event.id, event]));
    const expectedIds = [ids.eventA, ...volumeEventIds].sort((left, right) => {
      const leftEvent = left === ids.eventA ? { evaluatedAt: new Date("2026-01-01T10:00:00Z"), id: left } : volumeEventById.get(left)!;
      const rightEvent = right === ids.eventA ? { evaluatedAt: new Date("2026-01-01T10:00:00Z"), id: right } : volumeEventById.get(right)!;
      return rightEvent.evaluatedAt.getTime() - leftEvent.evaluatedAt.getTime() || right.localeCompare(left);
    });
    const actualIds = volumeExport.records.map((record: any) => record.id);
    assert(volumeExport.recordCount === expectedIds.length, "Large export count must honor every filter");
    assert(actualIds.length === expectedIds.length && new Set(actualIds).size === expectedIds.length, "Every filtered record must appear exactly once across batch boundaries");
    assert(actualIds.every((eventId: string, index: number) => eventId === expectedIds[index]), "Large export order must be deterministic for shared timestamps");
    assert(volumeExport.records.every((record: any) => record.learnerId === ids.learnerA
      && record.pathwayId === ids.pathwayA && record.status === "Developing" && record.ruleVersion === 2), "Large export must preserve all requested filters");
    assert(slowExport.backpressureCount > 0, "A slow client must trigger server response backpressure");
    assert(slowExport.maxBufferedBytes <= slowExport.highWaterMark + 16_384, "Server response buffering must remain bounded near its stream high-water mark");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.delete(readinessEventsTable).where(inArray(readinessEventsTable.id, [ids.eventA, ids.eventB, ids.eventC, ...volumeEventIds]));
    await db.delete(readinessGatesTable).where(inArray(readinessGatesTable.id, [ids.gateA, ids.gateB]));
    await db.delete(enrollmentsTable).where(inArray(enrollmentsTable.id, [ids.enrollmentA, ids.enrollmentB]));
    await db.delete(pathwaysTable).where(inArray(pathwaysTable.id, [ids.pathwayA, ids.pathwayB]));
    await db.delete(programsTable).where(inArray(programsTable.id, [ids.program]));
    await db.delete(peopleTable).where(inArray(peopleTable.id, [ids.learnerA, ids.learnerB]));
  }
}

await run();