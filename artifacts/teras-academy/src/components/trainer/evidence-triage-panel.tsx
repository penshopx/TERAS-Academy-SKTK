import { useCreateTrainerEvidenceTriageRun } from "@workspace/api-client-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Result = NonNullable<ReturnType<typeof useCreateTrainerEvidenceTriageRun>["data"]>;

export function EvidenceTriagePanel() {
  const [result, setResult] = useState<Result>();
  const mutation = useCreateTrainerEvidenceTriageRun({ mutation: { onSuccess: setResult } });
  return (
    <Card className="mt-4 border-primary/20 bg-black/20">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="font-mono text-sm uppercase tracking-wider">Evidence Triage · Path A</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">Analisis hanya saat diminta, untuk bukti persiapan pada assignment aktif.</p>
        </div>
        <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Memeriksa..." : "Periksa bukti"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm" aria-live="polite">
        {mutation.isError && <p role="alert" className="text-destructive">Triage gagal dibuat. Coba lagi; tidak ada bukti atau review yang berubah.</p>}
        {result && (
          <>
            <p className="text-xs text-muted-foreground">Diperiksa {new Date(result.asOf).toLocaleString("id-ID")} · {result.status === "PARTIAL" ? "Urutan lokal digunakan" : "Selesai"}</p>
            {result.categories.length === 0 && <p>Tidak ada kekurangan yang terdeteksi pada bukti dalam lingkup.</p>}
            {result.categories.map(category => (
              <section key={category.category} className="rounded-md border border-border/60 p-3">
                <h3 className="font-semibold">{category.label} · {category.priority} · {category.count}</h3>
                <p className="mt-1 text-muted-foreground">{category.action}</p>
                <ul className="mt-2 space-y-1">
                  {category.items.map((item, index) => (
                    <li key={`${item.learnerId}-${item.pathwayId}-${item.evidenceRef}-${index}`} className="font-mono text-xs">
                      {item.learnerName} · {item.moduleId} · <span className="break-all">{item.evidenceRef}</span>
                    </li>
                  ))}
                </ul>
                {category.omittedCount > 0 && <p className="mt-2 text-xs text-muted-foreground">+{category.omittedCount} referensi lain tidak ditampilkan.</p>}
              </section>
            ))}
            <div className="text-xs text-muted-foreground">
              {result.limitations.map(limitation => <p key={limitation}>{limitation}</p>)}
              <p className="mt-2">{result.advisoryNotice}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}