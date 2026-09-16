export const SUPPORTED_PORTFOLIO_SCHEMA_VERSION = "1.0";
export const SUPPORTED_PORTFOLIO_CANONICALIZATION = "teras-learner-portfolio-v1-json-stringify";
export const MAX_PORTFOLIO_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_PORTFOLIO_FILE_SIZE_LABEL = "5 MiB";

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

export function rejectOversizedPortfolioFile(fileSize: number): PortfolioVerificationResult | null {
  if (fileSize <= MAX_PORTFOLIO_FILE_SIZE_BYTES) return null;

  return {
    status: "rejected",
    message: `Ukuran file melebihi batas ${MAX_PORTFOLIO_FILE_SIZE_LABEL}. Pilih file portfolio yang lebih kecil.`,
  };
}

export async function verifyPortfolioFile(
  file: Pick<File, "size" | "text">,
): Promise<PortfolioVerificationResult> {
  const sizeRejection = rejectOversizedPortfolioFile(file.size);
  if (sizeRejection) return sizeRejection;

  return verifyPortfolioText(await file.text());
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
  const calculatedChecksum = await sha256Hex(JSON.stringify(canonicalPayload));

  return {
    status: calculatedChecksum === document.integrity.checksum ? "match" : "mismatch",
    documentId: document.documentId,
    exportedAt: document.exportedAt,
    expectedChecksum: document.integrity.checksum,
    calculatedChecksum,
  };
}