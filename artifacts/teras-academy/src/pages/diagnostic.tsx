import React, { useMemo, useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import {
  useGetDiagnostic,
  useStartDiagnosticSession,
  useSaveDiagnosticResponses,
  useCompleteDiagnosticSession,
  getGetDiagnosticQueryKey,
  getGetCompetencyProfileQueryKey,
  getGetReadinessMapQueryKey,
  getGetLearnerDashboardQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowRight, Save, Target, CheckCircle2, AlertTriangle, Lightbulb } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export default function Diagnostic() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: diagnostic, isLoading, isError, error } = useGetDiagnostic();
  const startSession = useStartDiagnosticSession();
  const saveResponses = useSaveDiagnosticResponses();
  const completeSession = useCompleteDiagnosticSession();

  const [currentDimensionIndex, setCurrentDimensionIndex] = useState(0);
  const [localResponses, setLocalResponses] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const initializedSessionId = useRef<string | null>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);

  const dimensions = useMemo(() => diagnostic?.template.dimensions || [], [diagnostic?.template]);
  
  // Initialize local responses from server once per session and set initial dimension
  useEffect(() => {
    if (diagnostic?.session && initializedSessionId.current !== diagnostic.session.id) {
      initializedSessionId.current = diagnostic.session.id;
      
      const respMap: Record<string, string> = {};
      if (diagnostic.responses) {
        diagnostic.responses.forEach(r => {
          respMap[r.questionId] = r.optionId;
        });
      }
      setLocalResponses(respMap);
      
      // Calculate first incomplete dimension
      const questionsByDim = diagnostic.questions.reduce((acc, q) => {
        if (!acc[q.dimension]) acc[q.dimension] = [];
        acc[q.dimension].push(q);
        return acc;
      }, {} as Record<string, typeof diagnostic.questions>);

      let firstIncompleteIdx = 0;
      for (let i = 0; i < dimensions.length; i++) {
        const dimQs = questionsByDim[dimensions[i]] || [];
        const isComplete = dimQs.every(q => !q.required || respMap[q.id]);
        if (!isComplete) {
          firstIncompleteIdx = i;
          break;
        }
      }
      setCurrentDimensionIndex(firstIncompleteIdx);
    }
  }, [diagnostic, dimensions]);

  const currentDimension = dimensions[currentDimensionIndex];
  
  const currentQuestions = useMemo(() => {
    if (!diagnostic || !currentDimension) return [];
    return diagnostic.questions
      .filter(q => q.dimension === currentDimension)
      .sort((a, b) => a.sequence - b.sequence);
  }, [diagnostic, currentDimension]);

  // Only count progress for questions actually in the template
  const totalQuestions = diagnostic?.questions.length || 0;
  const answeredCount = useMemo(() => {
    if (!diagnostic) return 0;
    const validQuestionIds = new Set(diagnostic.questions.map(q => q.id));
    return Object.keys(localResponses).filter(id => validQuestionIds.has(id)).length;
  }, [diagnostic, localResponses]);
  
  const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;

  const handleStart = () => {
    startSession.mutate(
      { data: {} },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDiagnosticQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetLearnerDashboardQueryKey() });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Gagal memulai sesi",
            description: "Terjadi kesalahan saat memulai diagnostik. Silakan coba lagi.",
          });
        }
      }
    );
  };

  const handleOptionSelect = (questionId: string, optionId: string) => {
    setLocalResponses(prev => ({ ...prev, [questionId]: optionId }));
  };

  const saveCurrentProgress = async (isExplicitSave = false) => {
    if (!diagnostic?.session) return true;
    setIsSaving(true);
    
    // Filter only valid responses
    const validQuestionIds = new Set(diagnostic.questions.map(q => q.id));
    const responsesArray = Object.entries(localResponses)
      .filter(([qId]) => validQuestionIds.has(qId))
      .map(([questionId, optionId]) => ({
        questionId,
        optionId,
      }));
    
    try {
      await saveResponses.mutateAsync({
        sessionId: diagnostic.session.id,
        data: {
          responses: responsesArray,
          progress,
        },
      });
      // Do not invalidate diagnostic key on save to avoid overwriting newer local edits if user types fast
      if (isExplicitSave) {
        toast({
          title: "Progres tersimpan",
          description: "Jawaban diagnostik Anda telah berhasil disimpan.",
        });
      }
      return true;
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Gagal menyimpan",
        description: "Terjadi kesalahan saat menyimpan jawaban. Periksa koneksi Anda.",
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const changeStage = (newIdx: number) => {
    setCurrentDimensionIndex(newIdx);
    window.scrollTo(0, 0);
    // Use setTimeout to ensure DOM has updated before focusing
    setTimeout(() => {
      stageHeadingRef.current?.focus();
    }, 0);
  };

  const handleNext = async () => {
    const success = await saveCurrentProgress();
    if (success && currentDimensionIndex < dimensions.length - 1) {
      changeStage(currentDimensionIndex + 1);
    }
  };

  const handlePrevious = () => {
    if (currentDimensionIndex > 0) {
      changeStage(currentDimensionIndex - 1);
    }
  };

  const handleTabClick = async (i: number) => {
    if (i === currentDimensionIndex) return;
    const success = await saveCurrentProgress();
    if (success) {
      changeStage(i);
    }
  };

  const handleSaveAndExit = async () => {
    const success = await saveCurrentProgress(true);
    if (success) {
      setLocation("/dashboard");
    }
  };

  // Find incomplete dimensions
  const incompleteRequiredCount = useMemo(() => {
    if (!diagnostic) return 0;
    return diagnostic.questions.filter(q => q.required && !localResponses[q.id]).length;
  }, [diagnostic, localResponses]);

  const handleComplete = async () => {
    if (!diagnostic?.session) return;
    
    // Validation check across ALL dimensions
    const questionsByDim = diagnostic.questions.reduce((acc, q) => {
      if (!acc[q.dimension]) acc[q.dimension] = [];
      acc[q.dimension].push(q);
      return acc;
    }, {} as Record<string, typeof diagnostic.questions>);

    let firstIncompleteIdx = -1;
    for (let i = 0; i < dimensions.length; i++) {
      const dimQs = questionsByDim[dimensions[i]] || [];
      const isComplete = dimQs.every(q => !q.required || localResponses[q.id]);
      if (!isComplete) {
        firstIncompleteIdx = i;
        break;
      }
    }

    if (firstIncompleteIdx !== -1) {
      toast({
        variant: "destructive",
        title: "Penyelesaian diblokir",
        description: `Masih ada pertanyaan wajib yang belum diisi.`,
      });
      // Move to first incomplete stage
      if (currentDimensionIndex !== firstIncompleteIdx) {
        const success = await saveCurrentProgress();
        if (success) changeStage(firstIncompleteIdx);
      }
      return;
    }

    const success = await saveCurrentProgress();
    if (!success) return;

    completeSession.mutate(
      { sessionId: diagnostic.session.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDiagnosticQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetLearnerDashboardQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetCompetencyProfileQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetReadinessMapQueryKey() });
          setLocation("/competency-profile");
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Gagal menyelesaikan sesi",
            description: "Terjadi kesalahan sistem. Silakan coba lagi.",
          });
        }
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-primary">
          <Activity className="h-10 w-10 animate-pulse" />
          <p className="font-mono text-sm tracking-widest uppercase">Memuat Diagnostik...</p>
        </div>
      </div>
    );
  }

  if (isError || !diagnostic) {
    return (
      <div className="container py-8 max-w-2xl mx-auto animate-in fade-in">
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Diagnostik Tidak Tersedia
            </CardTitle>
            <CardDescription>
              Kami tidak dapat memuat templat diagnostik. Anda mungkin belum memiliki enrollment yang sesuai.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (diagnostic.session?.status === "completed") {
    return (
      <div className="container py-12 max-w-2xl mx-auto animate-in fade-in zoom-in-95">
        <Card className="cockpit-panel text-center py-12 px-6">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 mb-6">
            <CheckCircle2 className="h-8 w-8 text-primary" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Diagnostik Selesai</h2>
          <p className="text-muted-foreground mb-8 max-w-md mx-auto">
            Anda telah menyelesaikan sesi diagnostik ini. Lihat profil kapabilitas Anda untuk melihat peta kesiapan dan area yang perlu ditingkatkan.
          </p>
          <Button onClick={() => setLocation("/competency-profile")} className="font-mono uppercase tracking-wide">
            Lihat Profil Kompetensi <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Card>
      </div>
    );
  }

  // Introduction view if no active session
  if (!diagnostic.session) {
    return (
      <div className="container py-12 max-w-3xl mx-auto animate-in fade-in slide-in-from-bottom-8 duration-700">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 mb-6">
            <Target className="h-4 w-4 text-primary" />
            <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-primary uppercase">Diagnostik Kapabilitas Personal</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4">{diagnostic.template.name}</h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">{diagnostic.template.description}</p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 mb-10">
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-mono text-muted-foreground uppercase tracking-wider">Format</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-medium text-lg">{diagnostic.template.dimensions.length} Tahapan</p>
              <p className="text-sm text-muted-foreground mt-1">Mencakup Profil, Pengetahuan, dan Keselamatan (Safety)</p>
            </CardContent>
          </Card>
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-mono text-muted-foreground uppercase tracking-wider">Tujuan</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-medium text-lg">Pemetaan Kesiapan</p>
              <p className="text-sm text-muted-foreground mt-1">Identifikasi kesenjangan sebelum asesmen resmi LSK</p>
            </CardContent>
          </Card>
        </div>

        <Card className="border-primary/20 bg-gradient-to-b from-primary/5 to-transparent">
          <CardContent className="p-8 text-center">
            <p className="text-sm font-medium mb-6">
              Ini bukan tes resmi. Jawablah dengan jujur untuk mendapatkan peta kesiapan (Readiness Map) yang akurat dan rencana perbaikan yang personal.
            </p>
            <Button
              size="lg"
              onClick={handleStart}
              disabled={startSession.isPending}
              className="w-full sm:w-auto font-mono uppercase tracking-wider px-8"
            >
              {startSession.isPending ? "Memulai..." : "Mulai Diagnostik"} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Active Session View
  const isLastStage = currentDimensionIndex === dimensions.length - 1;
  const allCurrentQuestionsAnswered = currentQuestions.every(q => !q.required || localResponses[q.id]);

  return (
    <div className="container py-8 max-w-3xl mx-auto space-y-8 animate-in fade-in">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">{diagnostic.template.name}</h1>
          <div className="flex items-center gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleSaveAndExit} 
              disabled={isSaving}
              className="font-mono text-xs hidden sm:inline-flex"
            >
              Simpan & Keluar
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => saveCurrentProgress(true)} 
              disabled={isSaving}
              className="font-mono text-xs"
            >
              <Save className="mr-2 h-3.5 w-3.5" />
              {isSaving ? "Menyimpan..." : "Simpan"}
            </Button>
          </div>
        </div>
        
        <div className="space-y-2">
          <div className="flex justify-between text-xs font-mono uppercase tracking-wider text-muted-foreground" aria-hidden="true">
            <span>Progres Keseluruhan</span>
            <span className="text-primary">{progress}%</span>
          </div>
          <Progress value={progress} className="h-2" aria-label={`Progres diagnostik: ${progress} persen`} />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none custom-scrollbar" role="tablist">
          {dimensions.map((dim, i) => (
            <button
              key={dim}
              role="tab"
              aria-selected={i === currentDimensionIndex}
              onClick={() => handleTabClick(i)}
              className={cn(
                "whitespace-nowrap px-4 py-2 text-xs font-mono font-medium rounded-full border transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                i === currentDimensionIndex
                  ? "bg-primary text-primary-foreground border-primary"
                  : i < currentDimensionIndex 
                    ? "bg-primary/10 text-primary border-primary/20 hover:bg-primary/20" 
                    : "bg-transparent text-muted-foreground border-border hover:border-foreground/30"
              )}
            >
              {i + 1}. {dim.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </header>

      <main className="space-y-8 min-h-[50vh]">
        <div className="mb-6">
          <h2 ref={stageHeadingRef} tabIndex={-1} className="text-xl font-bold capitalize focus:outline-none">
            {currentDimension.replace(/_/g, ' ')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">Harap isi semua pertanyaan wajib pada bagian ini.</p>
        </div>

        {currentQuestions.map((q, idx) => (
          <Card key={q.id} className={cn("cockpit-panel transition-all", localResponses[q.id] ? "border-primary/30 bg-primary/[0.02]" : "")}>
            <CardHeader className="pb-4">
              <div className="flex items-start gap-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-xs font-mono text-muted-foreground">
                  {idx + 1}
                </div>
                <div className="space-y-1 mt-1">
                  <CardTitle className="text-base leading-relaxed">
                    {q.prompt}
                    {q.required && <span className="text-destructive ml-1">*</span>}
                  </CardTitle>
                  {q.explanation && (
                    <CardDescription className="flex items-start gap-2 mt-2 bg-primary/5 p-3 rounded text-primary/80">
                      <Lightbulb className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>{q.explanation}</span>
                    </CardDescription>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="pl-[3.25rem]">
              <RadioGroup 
                value={localResponses[q.id] || ""} 
                onValueChange={(val) => handleOptionSelect(q.id, val)}
                className="space-y-3"
              >
                {q.options.map((opt) => (
                  <div key={opt.id} className="flex items-center space-x-3">
                    <RadioGroupItem value={opt.id} id={`opt-${opt.id}`} />
                    <Label 
                      htmlFor={`opt-${opt.id}`} 
                      className="text-sm font-medium leading-relaxed cursor-pointer peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {opt.label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </CardContent>
          </Card>
        ))}

        {currentQuestions.length === 0 && (
          <div className="text-center py-12 text-muted-foreground font-mono text-sm">
            Tidak ada pertanyaan untuk bagian ini.
          </div>
        )}
      </main>

      <footer className="flex items-center justify-between border-t border-border pt-6 pb-12">
        <Button 
          variant="outline" 
          onClick={handlePrevious} 
          disabled={currentDimensionIndex === 0 || isSaving}
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Sebelumnya
        </Button>
        
        {isLastStage ? (
          <div className="flex flex-col items-end gap-2">
            <Button 
              onClick={handleComplete} 
              disabled={completeSession.isPending || isSaving}
              className="font-bold"
            >
              {completeSession.isPending ? "Menyelesaikan..." : "Selesaikan Diagnostik"} <CheckCircle2 className="ml-2 h-4 w-4" />
            </Button>
            {incompleteRequiredCount > 0 && (
              <p className="text-xs font-mono text-destructive tracking-wide text-right">
                {incompleteRequiredCount} pertanyaan wajib belum diisi
              </p>
            )}
          </div>
        ) : (
          <Button 
            onClick={handleNext} 
            disabled={!allCurrentQuestionsAnswered || isSaving}
          >
            Tahap Selanjutnya <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </footer>
    </div>
  );
}
