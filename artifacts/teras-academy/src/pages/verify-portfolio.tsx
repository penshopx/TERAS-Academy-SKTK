import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, FileJson, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  MAX_PORTFOLIO_FILE_SIZE_LABEL,
  verifyPortfolioFile,
  type PortfolioVerificationResult,
} from "@/lib/portfolio-verification";

export default function VerifyPortfolio() {
  const [result, setResult] = useState<PortfolioVerificationResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const activeCheck = useRef<AbortController | null>(null);

  useEffect(() => () => {
    activeCheck.current?.abort();
    activeCheck.current = null;
  }, []);

  const checkFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    activeCheck.current?.abort();
    const controller = new AbortController();
    activeCheck.current = controller;
    event.target.value = "";
    setFileName(file.name);
    setResult(null);

    setIsChecking(true);
    try {
      const verification = await verifyPortfolioFile(file, { signal: controller.signal });
      if (!controller.signal.aborted) setResult(verification);
    } catch {
      if (!controller.signal.aborted) {
        setResult({ status: "rejected", message: "Browser tidak dapat menghitung checksum file ini." });
      }
    } finally {
      if (!controller.signal.aborted) {
        activeCheck.current = null;
        setIsChecking(false);
      }
    }
  };

  const matched = result?.status === "match";
  const mismatched = result?.status === "mismatch";
  const resultDescription = result?.status === "match"
    ? "Isi payload sesuai dengan checksum yang tercantum saat file diekspor."
    : result?.status === "mismatch"
      ? "Isi file telah berubah atau checksum di dalam file tidak sesuai."
      : result?.status === "rejected"
        ? result.message
        : "";

  return (
    <main className="min-h-[100dvh] bg-background px-5 py-10 text-foreground md:py-16">
      <div className="mx-auto max-w-3xl space-y-8">
        <header className="space-y-4">
          <Link href="/" className="text-sm font-semibold text-primary hover:underline" data-testid="link-verifier-home">
            ← Kembali ke TERAS Academy
          </Link>
          <div className="flex items-center gap-3 text-primary">
            <ShieldCheck className="h-7 w-7" />
            <span className="text-xs font-bold uppercase tracking-[0.2em]">Pemeriksaan integritas lokal</span>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight md:text-5xl">Verifikasi file portfolio</h1>
          <p className="max-w-2xl leading-7 text-muted-foreground">
            Pilih file JSON yang diterima dari learner. Pemeriksaan berlangsung sepenuhnya di browser dan isi file tidak diunggah ke TERAS.
          </p>
        </header>

        <Card className="border-primary/30 bg-card/70 shadow-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileJson className="h-5 w-5 text-primary" />Pilih dokumen</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <Button asChild className="w-full sm:w-auto">
              <label data-testid="button-select-portfolio">
                {isChecking ? "Menghitung checksum…" : "Pilih file portfolio JSON"}
                <input
                  className="sr-only"
                  type="file"
                  accept=".json,application/json"
                  onChange={checkFile}
                  disabled={isChecking}
                  data-testid="input-portfolio-file"
                />
              </label>
            </Button>
            <p className="text-sm text-muted-foreground">
              Maksimum {MAX_PORTFOLIO_FILE_SIZE_LABEL}. File diperiksa di browser dan tidak diunggah.
            </p>
            {fileName && <p className="text-sm text-muted-foreground" data-testid="text-selected-file">File: {fileName}</p>}
          </CardContent>
        </Card>

        {result && (
          <Card
            className={matched ? "border-emerald-500/50" : mismatched ? "border-destructive/60" : "border-amber-500/50"}
            data-testid="status-portfolio-verification"
          >
            <CardContent className="space-y-5 pt-6">
              <div className="flex items-start gap-3">
                {matched ? <CheckCircle2 className="mt-0.5 h-7 w-7 shrink-0 text-emerald-500" /> : mismatched ? <XCircle className="mt-0.5 h-7 w-7 shrink-0 text-destructive" /> : <AlertTriangle className="mt-0.5 h-7 w-7 shrink-0 text-amber-500" />}
                <div>
                  <h2 className="text-xl font-bold">
                    {matched ? "Checksum cocok" : mismatched ? "Checksum tidak cocok" : "File ditolak"}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {resultDescription}
                  </p>
                </div>
              </div>

              {result.status !== "rejected" && (
                <dl className="grid gap-4 rounded-lg border border-border/60 bg-muted/20 p-4 text-sm sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">ID dokumen</dt><dd className="mt-1 break-all font-mono font-semibold" data-testid="text-document-id">{result.documentId}</dd></div>
                  <div><dt className="text-muted-foreground">Diekspor pada</dt><dd className="mt-1 font-mono font-semibold" data-testid="text-exported-at">{result.exportedAt}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-muted-foreground">Checksum tercantum</dt><dd className="mt-1 break-all font-mono text-xs" data-testid="text-expected-checksum">{result.expectedChecksum}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-muted-foreground">Checksum hasil hitung</dt><dd className="mt-1 break-all font-mono text-xs" data-testid="text-calculated-checksum">{result.calculatedChecksum}</dd></div>
                </dl>
              )}
            </CardContent>
          </Card>
        )}

        <aside className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm leading-6" role="note" data-testid="note-verifier-disclaimer">
          Pemeriksaan ini hanya memvalidasi integritas file portfolio internal TERAS. Hasilnya bukan sertifikat, bukan keputusan kompetensi resmi, dan bukan bukti sertifikasi.
        </aside>
      </div>
    </main>
  );
}