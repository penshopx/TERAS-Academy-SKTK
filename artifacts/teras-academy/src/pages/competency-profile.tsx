import React from "react";
import { Link } from "wouter";
import { useGetCompetencyProfile } from "@workspace/api-client-react";
import { Activity, ShieldAlert, Target, ShieldCheck, FileSignature, ArrowRight, Zap, AlertTriangle, BookOpen, AlertOctagon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export default function CompetencyProfile() {
  const { data: profile, isLoading, isError } = useGetCompetencyProfile();

  if (isLoading) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-primary">
          <Activity className="h-10 w-10 animate-pulse" />
          <p className="font-mono text-sm tracking-widest uppercase">Memuat Profil...</p>
        </div>
      </div>
    );
  }

  // If no profile found (404) or general error, show the empty state guide.
  if (isError || !profile) {
    return (
      <div className="container py-12 max-w-2xl mx-auto animate-in fade-in zoom-in-95">
        <Card className="cockpit-panel text-center py-12 px-6">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 mb-6">
            <Target className="h-8 w-8 text-primary" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Profil Kompetensi Tidak Ditemukan</h2>
          <p className="text-muted-foreground mb-8 max-w-md mx-auto">
            Anda belum menyelesaikan sesi diagnostik. Selesaikan diagnostik kapabilitas personal Anda untuk menghasilkan profil kompetensi dan peta kesiapan.
          </p>
          <Link href="/diagnostic">
            <Button className="font-mono uppercase tracking-wide">
              Mulai Diagnostik <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  const criticalGaps = profile.gaps.filter(g => g.severity === "CRITICAL" || g.severity === "critical");
  const strengths = profile.items.filter(i => i.score >= 80);
  const devAreas = profile.items.filter(i => i.score < 80);

  const highestPriorityRec = profile.recommendations.find(r => r.priority === "HIGH" || r.priority === "high") 
    || profile.recommendations[0];

  return (
    <div className="container py-8 max-w-5xl mx-auto space-y-8 animate-in fade-in">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Profil Kompetensi</h1>
          <p className="text-muted-foreground mt-1">Pemetaan kapabilitas Anda saat ini berdasarkan diagnostik</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="font-mono uppercase px-3 py-1">
            Framework: {profile.frameworkId}
          </Badge>
          <Badge variant={profile.safetyOverride ? "destructive" : "outline"} className="font-mono uppercase px-3 py-1">
            {profile.safetyOverride ? "Penangguhan Keselamatan Aktif" : "Keselamatan Aman"}
          </Badge>
        </div>
      </header>

      {profile.safetyOverride && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 flex items-start gap-4">
          <AlertOctagon className="h-6 w-6 text-destructive shrink-0 mt-0.5" />
          <div>
            <h3 className="font-bold text-destructive">Batas Keselamatan Terblokir (Safety Gate Blocked)</h3>
            <p className="text-sm text-destructive/80 mt-1">
              Profil Anda memicu penangguhan keselamatan (safety override) karena adanya kesenjangan kritis pada persyaratan keselamatan. Kesiapan untuk tahap berikutnya ditangguhkan hingga masalah ini diselesaikan.
            </p>
          </div>
        </div>
      )}

      {highestPriorityRec && (
        <Card className="bg-primary/5 border-primary/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-mono text-primary uppercase tracking-wider flex items-center gap-2">
              <Zap className="h-4 w-4" /> Tindakan Lanjutan
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <h3 className="text-xl font-bold">{highestPriorityRec.title}</h3>
              <p className="text-muted-foreground mt-1 text-sm">{highestPriorityRec.rationale}</p>
            </div>
            {highestPriorityRec.href && (
              <Link href={highestPriorityRec.href}>
                <Button className="shrink-0 font-mono uppercase tracking-wide">
                  Laksanakan <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <Card className="cockpit-panel">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" /> Ringkasan Dimensi
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {Object.entries(profile.dimensionSummaries).map(([dim, score]) => (
              <div key={dim} className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium capitalize">{dim.replace(/_/g, ' ')}</span>
                  <span className="font-mono">{score}%</span>
                </div>
                <Progress value={score} className="h-2" />
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="cockpit-panel h-full border-destructive/20">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" /> Kesenjangan Kritis
              </CardTitle>
            </CardHeader>
            <CardContent>
              {criticalGaps.length > 0 ? (
                <ul className="space-y-4">
                  {criticalGaps.map(gap => (
                    <li key={gap.id} className="border-l-2 border-destructive pl-4 py-1">
                      <div className="font-bold text-sm">{gap.unitTitle || gap.unitCode || gap.competencyUnitId}</div>
                      <div className="text-sm text-muted-foreground mt-1">{gap.diagnosis}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex items-center gap-3 text-muted-foreground py-4">
                  <ShieldCheck className="h-5 w-5 text-green-500" />
                  <span className="text-sm font-medium">Tidak ada kesenjangan kritis terdeteksi</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card className="cockpit-panel">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-green-500" /> Area Kekuatan
            </CardTitle>
          </CardHeader>
          <CardContent>
            {strengths.length > 0 ? (
              <div className="space-y-4">
                {strengths.map(item => (
                  <div key={item.competencyUnitId} className="flex items-center justify-between border-b border-border/50 pb-3 last:border-0 last:pb-0">
                    <div>
                      <div className="font-bold text-sm">{item.unitTitle}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-1">{item.unitCode}</div>
                    </div>
                    <Badge variant="outline" className="font-mono bg-green-500/10 text-green-500 border-green-500/20">
                      {item.score}%
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Belum cukup data untuk menentukan area kekuatan.</p>
            )}
          </CardContent>
        </Card>

        <Card className="cockpit-panel">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-amber-500" /> Area Pengembangan
            </CardTitle>
          </CardHeader>
          <CardContent>
            {devAreas.length > 0 ? (
              <div className="space-y-4">
                {devAreas.map(item => (
                  <div key={item.competencyUnitId} className="flex items-center justify-between border-b border-border/50 pb-3 last:border-0 last:pb-0">
                    <div>
                      <div className="font-bold text-sm">{item.unitTitle}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-1">Level: {item.evidenceLevel}</div>
                    </div>
                    <Badge variant="outline" className="font-mono bg-amber-500/10 text-amber-500 border-amber-500/20">
                      {item.score}%
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Tidak ada area pengembangan signifikan yang perlu disoroti.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-center pt-4">
        <Link href="/readiness-map">
          <Button variant="outline" className="font-mono uppercase tracking-wide">
            Lihat Peta Kesiapan <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  );
}
