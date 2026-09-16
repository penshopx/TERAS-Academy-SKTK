import React from "react";
import { Link } from "wouter";
import { useGetReadinessMap } from "@workspace/api-client-react";
import { Activity, Network, CheckCircle2, Lock, Milestone, ShieldAlert, ArrowRight, AlertTriangle, Info } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { getReadinessPresentation } from "@/lib/readiness-presentation";
import { getGateStatusPresentation } from "@/lib/gate-status-presentation";

export default function ReadinessMap() {
  const { data: mapData, isLoading, isError } = useGetReadinessMap();

  if (isLoading) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-primary">
          <Activity className="h-10 w-10 animate-pulse" />
          <p className="font-mono text-sm tracking-widest uppercase">Memetakan Kesiapan...</p>
        </div>
      </div>
    );
  }

  if (isError || !mapData) {
    return (
      <div className="container py-12 max-w-2xl mx-auto animate-in fade-in zoom-in-95">
        <Card className="cockpit-panel text-center py-12 px-6">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 mb-6">
            <Network className="h-8 w-8 text-primary" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Peta Kesiapan Tidak Tersedia</h2>
          <p className="text-muted-foreground mb-8 max-w-md mx-auto">
            Anda perlu menyelesaikan diagnostik profil kompetensi sebelum peta kesiapan dapat dihasilkan.
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

  const { profile, readiness } = mapData;
  const readinessPresentation = getReadinessPresentation(readiness.status);
  const hasBlockers = readiness.blockers && readiness.blockers.length > 0;

  return (
    <div className="container py-8 max-w-5xl mx-auto space-y-8 animate-in fade-in">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 mb-4">
            <Network className="h-4 w-4 text-primary" />
            <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-primary uppercase">Peta Kesiapan</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Peta Kesiapan</h1>
          <p className="text-muted-foreground mt-1 text-sm max-w-xl">
            Pandangan terpadu dari profil diagnostik personal Anda dan kesiapan internal TERAS menuju tahap sertifikasi berikutnya.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={readinessPresentation.badgeVariant} className="font-mono uppercase px-3 py-1 text-sm border-2">
            Status: {readinessPresentation.label}
          </Badge>
        </div>
      </header>

      {/* BOUNDARY DISCLAIMER */}
      <Card className="border-primary/40 bg-gradient-to-r from-primary/10 to-transparent">
        <CardContent className="p-4 flex items-start gap-4">
          <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div className="text-sm text-foreground/90 leading-relaxed">
            <strong>BATASAN DIAGNOSTIK:</strong> Peta ini memisahkan <em>status diagnostik mandiri (kiri/atas)</em> dari <em>status kesiapan internal TERAS (kanan/bawah)</em>. Data diagnostik berfungsi untuk persiapan dan analisis kesenjangan personal Anda; ini <strong>tidak memberikan otorisasi kelulusan</strong> atau menggantikan gerbang asesmen resmi. Keputusan sertifikasi akhir tetap menjadi kewenangan penuh Asesor dan Lembaga Sertifikasi Kompetensi (LSK).
          </div>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-[1fr_300px] gap-8">
        
        {/* LEFT COLUMN: DIAGNOSTIC / PROFILE MAP */}
        <div className="space-y-6">
          <h2 className="text-xl font-bold font-mono tracking-tight uppercase border-b pb-2 text-muted-foreground">Status Diagnostik</h2>
          
          {/* Target Framework */}
          <Card className="bg-card border-border border-l-4 border-l-primary shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 bg-primary/10 text-primary font-mono text-[10px] uppercase px-2 py-1 rounded-bl-lg font-bold">Kerangka Target</div>
            <CardContent className="p-5">
              <h3 className="font-bold text-lg">{readiness.pathway.name}</h3>
              <p className="text-sm text-muted-foreground font-mono mt-1">ID: {readiness.pathway.id} • V: {profile.frameworkVersion}</p>
            </CardContent>
          </Card>

          <div className="pl-6 border-l-2 border-border/50 space-y-6 relative ml-6">
            <div className="absolute -left-[5px] top-6 w-2 h-2 rounded-full bg-border" />
            <div className="absolute -left-[5px] bottom-6 w-2 h-2 rounded-full bg-border" />
            
            {/* Units & Gaps */}
            <Card className="cockpit-panel border-l-4 border-l-amber-500 relative">
              <div className="absolute top-0 right-0 bg-amber-500/10 text-amber-500 font-mono text-[10px] uppercase px-2 py-1 rounded-bl-lg font-bold">Profil Personal</div>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="font-bold">Unit Kompetensi</h4>
                  <Badge variant="outline" className="font-mono">{profile.items.length} unit dievaluasi</Badge>
                </div>
                
                <div className="space-y-3">
                  {profile.items.slice(0, 3).map((item) => (
                    <div key={item.competencyUnitId} className="flex justify-between items-center bg-background/50 p-2 rounded text-sm">
                      <span className="truncate pr-4">{item.unitTitle}</span>
                      <span className={cn("font-mono text-xs", item.score >= 80 ? "text-green-500" : "text-amber-500")}>
                        {item.score}%
                      </span>
                    </div>
                  ))}
                  {profile.items.length > 3 && (
                    <div className="text-xs text-muted-foreground font-mono text-center pt-2">
                      + {profile.items.length - 3} unit lainnya
                    </div>
                  )}
                </div>

                {profile.gaps.length > 0 && (
                  <div className="mt-5 pt-4 border-t border-border/50">
                    <h5 className="text-sm font-bold text-destructive flex items-center gap-2 mb-3">
                      <AlertTriangle className="h-4 w-4" /> Kesenjangan Terdeteksi
                    </h5>
                    <ul className="space-y-2">
                      {profile.gaps.map(gap => (
                        <li key={gap.id} className="text-xs border-l-2 border-destructive pl-3 py-1">
                          <strong className="block text-destructive/90">{gap.unitTitle || gap.unitCode}</strong>
                          <span className="text-muted-foreground">{gap.diagnosis}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recommendations */}
            {profile.recommendations.length > 0 && (
              <Card className="bg-primary/5 border-primary/20 relative">
                <div className="absolute top-0 right-0 bg-primary/20 text-primary font-mono text-[10px] uppercase px-2 py-1 rounded-bl-lg font-bold">Rekomendasi Tindakan</div>
                <CardContent className="p-5">
                  <h4 className="font-bold mb-1">{profile.recommendations[0].title}</h4>
                  <p className="text-sm text-muted-foreground mb-4">{profile.recommendations[0].rationale}</p>
                  {profile.recommendations[0].href && (
                    <Link href={profile.recommendations[0].href}>
                      <Button size="sm" className="font-mono text-xs uppercase tracking-wide">Ambil Tindakan</Button>
                    </Link>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: CANONICAL READINESS */}
        <div className="space-y-6">
          <h2 className="text-xl font-bold font-mono tracking-tight uppercase border-b pb-2 text-muted-foreground">Kesiapan Internal TERAS</h2>
          
          <Card className="cockpit-panel border-muted">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Skor Kesiapan</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-end gap-2 mb-2">
                <span className={cn("text-5xl font-bold font-mono tracking-tighter", readinessPresentation.scoreClassName)}>
                  {readiness.score}
                </span>
                <span className="text-muted-foreground pb-1">/ 100</span>
              </div>
              <Progress value={readiness.score} className="h-2 mb-4" />
              
              <div className="grid grid-cols-2 gap-2 text-xs font-mono text-center">
                <div className="bg-background/80 rounded p-2 border">
                  <div className="text-muted-foreground uppercase text-[10px]">Kesenjangan</div>
                  <div className={cn("font-bold text-sm", readiness.outstandingGapCount > 0 ? "text-amber-500" : "")}>{readiness.outstandingGapCount}</div>
                </div>
                <div className="bg-background/80 rounded p-2 border">
                  <div className="text-muted-foreground uppercase text-[10px]">Bukti Kurang</div>
                  <div className={cn("font-bold text-sm", readiness.missingEvidenceCount > 0 ? "text-destructive" : "")}>{readiness.missingEvidenceCount}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="cockpit-panel">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm uppercase tracking-wider font-mono">Gerbang Sertifikasi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {readiness.gates.map((gate, idx) => {
                const gatePresentation = getGateStatusPresentation(gate.status);
                const { isPassed, isBlocked } = gatePresentation;
                const isCurrent = gatePresentation.isCurrent && gate.id === readiness.currentGate.id;
                
                return (
                  <div key={gate.id} className="relative pl-6">
                    {/* Line connecting gates */}
                    {idx < readiness.gates.length - 1 && (
                      <div className={cn("absolute left-2.5 top-5 w-px h-full", isPassed ? "bg-primary" : "bg-border")} />
                    )}
                    
                    {/* Node */}
                    <div className={cn(
                      "absolute left-0 top-1 w-5 h-5 rounded-full flex items-center justify-center border-2",
                      isPassed ? "border-primary bg-primary/20" : isBlocked ? "border-destructive bg-destructive/20" : "border-border bg-background",
                      isCurrent && !isPassed ? "animate-pulse shadow-[0_0_8px_rgba(0,195,255,0.5)] border-primary bg-primary/50" : ""
                    )}>
                      {isPassed && <CheckCircle2 className="h-3 w-3 text-primary" />}
                      {isBlocked && <Lock className="h-3 w-3 text-destructive" />}
                      {!isPassed && !isBlocked && <Milestone className="h-3 w-3 text-muted-foreground" />}
                    </div>
                    
                    <div>
                      <h5 className={cn("font-bold text-sm", isPassed ? "text-foreground" : "text-muted-foreground")}>{gate.name}</h5>
                      <p className="text-xs text-muted-foreground mt-0.5">{gate.requirement}</p>
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          {hasBlockers && (
            <Card className="border-destructive/30 bg-destructive/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-bold text-destructive flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4" /> Kendala Aktif
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="text-xs space-y-1">
                  {readiness.blockers.map((b, i) => (
                    <li key={i} className="text-destructive/80">• {b}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

        </div>
      </div>
    </div>
  );
}
