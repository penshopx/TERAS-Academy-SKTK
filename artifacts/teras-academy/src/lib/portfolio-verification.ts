export const SUPPORTED_PORTFOLIO_SCHEMA_VERSION = "1.0";
export const SUPPORTED_PORTFOLIO_CANONICALIZATION = "teras-learner-portfolio-v1-json-stringify";
export const MAX_PORTFOLIO_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_PORTFOLIO_FILE_SIZE_LABEL = "5 MiB";
export const PORTFOLIO_VERIFICATION_TIMEOUT_MS = 5_000;

export const PORTFOLIO_COMPLEXITY_REJECTION_MESSAGE =
  "Struktur file terlalu kompleks untuk diverifikasi dengan aman.";

type PortfolioDocument = {
  schemaVersion: string;
  documentId: string;
  exportedAt: string;
  portfolio: unknown;
  integrity: {
    algorithm: string;
    checksum: string;
    canonicalization: string;
    verificationNote: string;
  };
};

export type PortfolioVerificationResult =
  | {
      status: "match" | "mismatch";
      documentId: string;
      exportedAt: string;
      expectedChecksum: string;
      calculatedChecksum: string;
    }
  | { status: "rejected"; message: string };

type VerificationWorker = {
  postMessage(value: string): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<PortfolioVerificationResult>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: () => void): void;
};

type VerifyPortfolioFileOptions = {
  createWorker?: () => VerificationWorker;
  timeoutMs?: number;
  signal?: AbortSignal;
};

function portfolioVerificationAbortError(): DOMException {
  return new DOMException("Pemeriksaan file dibatalkan.", "AbortError");
}

export function rejectOversizedPortfolioFile(fileSize: number): PortfolioVerificationResult | null {
  if (fileSize <= MAX_PORTFOLIO_FILE_SIZE_BYTES) return null;

  return {
    status: "rejected",
    message: `Ukuran file melebihi batas ${MAX_PORTFOLIO_FILE_SIZE_LABEL}. Pilih file portfolio yang lebih kecil.`,
  };
}

export async function verifyPortfolioFile(
  file: Pick<File, "size" | "text">,
  options: VerifyPortfolioFileOptions = {},
): Promise<PortfolioVerificationResult> {
  const { signal } = options;
  if (signal?.aborted) throw portfolioVerificationAbortError();
  const sizeRejection = rejectOversizedPortfolioFile(file.size);
  if (sizeRejection) return sizeRejection;

  const text = await file.text();
  if (signal?.aborted) throw portfolioVerificationAbortError();
  const createWorker = options.createWorker ?? (() => new Worker(
    new URL("./portfolio-verification.worker.ts", import.meta.url),
    { type: "module" },
  ));

  let worker: VerificationWorker;
  try {
    worker = createWorker();
  } catch {
    if (signal?.aborted) throw portfolioVerificationAbortError();
    return {
      status: "rejected",
      message: "Browser tidak mendukung pemeriksaan file lokal yang aman.",
    };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(portfolioVerificationAbortError());
    };
    const finish = (result: PortfolioVerificationResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = () => finish({
      status: "rejected",
      message: PORTFOLIO_COMPLEXITY_REJECTION_MESSAGE,
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    timeout = setTimeout(fail, options.timeoutMs ?? PORTFOLIO_VERIFICATION_TIMEOUT_MS);

    worker.addEventListener("message", event => finish(event.data));
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    try {
      worker.postMessage(text);
    } catch {
      fail();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePortfolioDocument(value: unknown): PortfolioDocument | PortfolioVerificationResult {
  if (!isRecord(value) || !isRecord(value.integrity)) {
    return { status: "rejected", message: "File bukan dokumen portfolio TERAS yang didukung." };
  }

  if (value.schemaVersion !== SUPPORTED_PORTFOLIO_SCHEMA_VERSION) {
    return { status: "rejected", message: `Schema portfolio tidak dikenal: ${String(value.schemaVersion ?? "tidak ada")}.` };
  }
  if (value.integrity.canonicalization !== SUPPORTED_PORTFOLIO_CANONICALIZATION) {
    return { status: "rejected", message: `Canonicalization tidak dikenal: ${String(value.integrity.canonicalization ?? "tidak ada")}.` };
  }
  if (value.integrity.algorithm !== "SHA-256") {
    return { status: "rejected", message: `Algoritma checksum tidak didukung: ${String(value.integrity.algorithm ?? "tidak ada")}.` };
  }
  if (
    typeof value.documentId !== "string"
    || typeof value.exportedAt !== "string"
    || !("portfolio" in value)
    || typeof value.integrity.checksum !== "string"
    || !/^[a-f0-9]{64}$/.test(value.integrity.checksum)
    || typeof value.integrity.verificationNote !== "string"
  ) {
    return { status: "rejected", message: "Struktur atau checksum dokumen portfolio tidak valid." };
  }

  return value as PortfolioDocument;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyPortfolioText(text: string): Promise<PortfolioVerificationResult> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { status: "rejected", message: "File tidak berisi JSON yang valid." };
  }

  const document = parsePortfolioDocument(decoded);
  if ("status" in document) return document;

  const canonicalPayload = {
    schemaVersion: document.schemaVersion,
    documentId: document.documentId,
    exportedAt: document.exportedAt,
    portfolio: document.portfolio,
  };
  let canonicalText: string;
  try {
    canonicalText = JSON.stringify(canonicalPayload);
  } catch {
    return { status: "rejected", message: PORTFOLIO_COMPLEXITY_REJECTION_MESSAGE };
  }

  let calculatedChecksum: string;
  try {
    calculatedChecksum = await sha256Hex(canonicalText);
  } catch {
    return { status: "rejected", message: "Browser tidak dapat menghitung checksum file ini." };
  }

  return {
    status: calculatedChecksum === document.integrity.checksum ? "match" : "mismatch",
    documentId: document.documentId,
    exportedAt: document.exportedAt,
    expectedChecksum: document.integrity.checksum,
    calculatedChecksum,
  };
}