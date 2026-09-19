import { useCreateTrainerIntelligenceRun } from "@workspace/api-client-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function TrainerIntelligencePanel() {
  const [result, setResult] = useState<Awaited<ReturnType<typeof useCreateTrainerIntelligenceRun>>["data"]>(undefined);
  const mutation = useCreateTrainerIntelligenceRun({
    mutation: {
      onSuccess: (data) => setResult(data),
    },
  });
  return (
    <Card className="border-primary/20 bg-black/20">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="font-mono text-sm uppercase tracking-wider">Trainer Intelligence</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">Grounded, read-only analysis of your assigned workspace.</p>
        </div>
        <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Generating..." : "Generate insights"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {mutation.error && (
          <div className="flex items-center justify-between gap-3 rounded border border-destructive/30 bg-destructive/10 p-3 text-destructive">
            <span>Insights could not be generated. Your dashboard is still available.</span>
            <Button variant="outline" size="sm" onClick={() => mutation.mutate()}>Retry</Button>
          </div>
        )}
        {!result && !mutation.isPending && !mutation.error && (
          <p className="text-muted-foreground">Generate an analysis when you need a current review priority summary.</p>
        )}
        {result && (
          <>
            <p className="text-xs text-muted-foreground">As of {new Date(result.asOf).toLocaleString()}</p>
            <section>
              <h3 className="mb-2 font-medium">Grounded insights</h3>
              <ul className="list-disc space-y-2 pl-5">
                {result.claims.length ? result.claims.map((claim, index) => <li key={`${claim.claim}-${index}`}>{claim.claim} <span className="text-xs text-muted-foreground">({claim.confidence})</span></li>) : <li className="text-muted-foreground">Insufficient grounded data for a claim.</li>}
              </ul>
            </section>
            <section>
              <h3 className="mb-2 font-medium">Recommended next actions</h3>
              <ul className="list-disc space-y-2 pl-5">{result.recommendedActions.map((item, index) => <li key={`${item.action}-${index}`}>{item.action}</li>)}</ul>
            </section>
            <section>
              <h3 className="mb-2 font-medium">Limitations</h3>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">{result.limitations.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
            </section>
            <p className="border-t border-border/50 pt-3 text-xs text-muted-foreground">{result.advisoryNotice}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}