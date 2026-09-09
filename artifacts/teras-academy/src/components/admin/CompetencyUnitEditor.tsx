import { useEffect, useState } from "react";
import { getListAdminAuditEventsQueryKey, getListAdminCompetencyFrameworksQueryKey, useCreateAdminCompetencyUnit, useUpdateAdminCompetencyFramework, useUpdateAdminCompetencyUnit } from "@workspace/api-client-react";
import type { AdminCompetencyFramework, AdminCompetencyUnit } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const csv = (value: FormDataEntryValue | null) => String(value ?? "").split(",").map(value => value.trim()).filter(Boolean);
const rows = (value: FormDataEntryValue | null) => String(value ?? "").split("\n").map(value => value.trim()).filter(Boolean);
function outcomeRows(value: FormDataEntryValue | null) {
  return rows(value).map(row => { const [learningOutcomeId = "", code = "", description = "", verificationMethod = "TRAINER_REVIEW"] = row.split("|"); return { learningOutcomeId: learningOutcomeId || null, outcomeCode: code, description, verificationMethod }; }).filter(row => row.outcomeCode && row.description);
}
function simulationRows(value: FormDataEntryValue | null) {
  return rows(value).map(row => { const [title = "", instructions = "", evidenceRequired = "", duration = "0"] = row.split("|"); return { title, instructions, evidenceRequired, durationMinutes: Number(duration) || 0 }; }).filter(row => row.title && row.instructions && row.evidenceRequired);
}
function safetyRows(value: FormDataEntryValue | null) {
  return rows(value).map(row => { const [code = "", rule = "", severity = "critical", verificationEvidence = "", blocking = "true"] = row.split("|"); return { code, rule, severity, verificationEvidence, blocking: blocking !== "false" }; }).filter(row => row.code && row.rule && row.verificationEvidence);
}
const errorText = (error: unknown) => (error as { data?: { error?: string }; message?: string })?.data?.error ?? (error as { message?: string })?.message ?? "Operasi tidak dapat diselesaikan.";

export function CompetencyUnitEditor({ frameworks, invalidate }: { frameworks: AdminCompetencyFramework[]; invalidate: (...keys: ReadonlyArray<readonly unknown[]>) => Promise<unknown[]> }) {
  const { toast } = useToast();
  const [frameworkId, setFrameworkId] = useState(frameworks[0]?.id ?? "");
  const [editing, setEditing] = useState<AdminCompetencyUnit | null>(null);
  const create = useCreateAdminCompetencyUnit();
  const update = useUpdateAdminCompetencyUnit();
  const updateFramework = useUpdateAdminCompetencyFramework();
  const selected = frameworks.find(framework => framework.id === frameworkId) ?? frameworks[0];
  useEffect(() => {
    if (!frameworks.length) { setFrameworkId(""); return; }
    if (!frameworks.some(framework => framework.id === frameworkId)) setFrameworkId(frameworks[0].id);
  }, [frameworks, frameworkId]);
  const saveUnit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!String(data.get("frameworkId") ?? "").trim()) { toast({ variant: "destructive", title: "Framework diperlukan", description: "Pilih framework sebelum menyimpan unit." }); return; }
    const payload: any = {
      id: editing?.id ?? crypto.randomUUID(), frameworkId: String(data.get("frameworkId")), code: String(data.get("code")),
      title: String(data.get("title")), description: String(data.get("description")), status: String(data.get("status") || "draft"),
      sequence: Number(data.get("sequence") || 1), pathwayIds: csv(data.get("pathwayIds")), outcomeMappings: outcomeRows(data.get("outcomes")),
      practiceTaskIds: csv(data.get("practiceTaskIds")), evidenceRequirementIds: csv(data.get("evidenceRequirementIds")),
      simulations: simulationRows(data.get("simulations")), safetyRules: safetyRows(data.get("safetyRules")),
    };
    const options: any = {
      onSuccess: async () => { await invalidate(getListAdminCompetencyFrameworksQueryKey(), getListAdminAuditEventsQueryKey()); setEditing(null); toast({ title: "Tersimpan", description: "Unit dan seluruh traceability diperbarui." }); },
      onError: (error: unknown) => toast({ variant: "destructive", title: "Gagal menyimpan unit", description: errorText(error) }),
    };
    if (editing) update.mutate({ unitId: editing.id, data: payload }, options);
    else create.mutate({ data: payload }, options);
  };
  const edit = (unit: AdminCompetencyUnit) => setEditing(unit);
  const value = (name: string) => {
    if (!editing) return "";
    if (name === "pathwayIds") return (editing.pathwayIds ?? []).join(", ");
    if (name === "practiceTaskIds") return (editing.practiceTaskIds ?? []).join(", ");
    if (name === "evidenceRequirementIds") return (editing.evidenceRequirementIds ?? []).join(", ");
    if (name === "outcomes") return (editing.outcomeMappings ?? []).map((row: any) => [row.learningOutcomeId ?? "", row.outcomeCode, row.description, row.verificationMethod].join("|")).join("\n");
    if (name === "simulations") return (editing.simulations ?? []).map((row: any) => [row.title, row.instructions, row.evidenceRequired, row.durationMinutes].join("|")).join("\n");
    if (name === "safetyRules") return (editing.safetyRules ?? []).map((row: any) => [row.code, row.rule, row.severity, row.verificationEvidence, row.blocking].join("|")).join("\n");
    return String((editing as any)[name] ?? "");
  };
  return <div className="space-y-4">
    <div className="rounded-md border-2 border-amber-500/60 bg-amber-50 p-4 text-sm font-medium text-amber-950">Penting: simulasi internal dan persiapan hanya untuk latihan/umpan balik. Ini bukan asesmen resmi dan tidak memberikan sertifikasi.</div>
    <Card><CardHeader><CardTitle>Unit kompetensi dan traceability</CardTitle></CardHeader><CardContent>
      <div className="mb-4 flex flex-wrap gap-2"><select className="h-10 rounded-md border bg-background px-3" value={frameworkId} onChange={event => setFrameworkId(event.target.value)}><option value="">Pilih framework</option>{frameworks.map(framework => <option key={framework.id} value={framework.id}>{framework.code} · {framework.name}</option>)}</select>{selected && <Button variant="outline" onClick={() => { const name = window.prompt("Nama framework", selected.name); if (name && name !== selected.name) updateFramework.mutate({ frameworkId: selected.id, data: { name } }, { onSuccess: () => invalidate(getListAdminCompetencyFrameworksQueryKey(), getListAdminAuditEventsQueryKey()), onError: error => toast({ variant: "destructive", title: "Gagal memperbarui framework", description: errorText(error) }) }); }}>Ubah nama framework</Button>}</div>
      <form key={editing?.id ?? `new-${frameworkId}`} onSubmit={saveUnit} className="grid gap-2 md:grid-cols-2">
        <input type="hidden" name="frameworkId" value={editing?.frameworkId ?? frameworkId} /><Input name="code" required placeholder="Kode unit" defaultValue={value("code")} /><Input name="title" required placeholder="Judul unit" defaultValue={value("title")} /><Input name="description" required placeholder="Deskripsi kompetensi" defaultValue={value("description")} /><Input name="sequence" type="number" min="1" required placeholder="Urutan" defaultValue={value("sequence") || "1"} /><select name="status" className="h-10 rounded-md border bg-background px-3" defaultValue={value("status") || "draft"}><option value="draft">Draft</option><option value="active">Aktif</option><option value="archived">Arsip</option></select>
        <Input name="pathwayIds" placeholder="Pathway IDs, pisahkan koma (path-a,path-b)" defaultValue={value("pathwayIds")} /><Input name="practiceTaskIds" placeholder="ID tugas praktik, pisahkan koma" defaultValue={value("practiceTaskIds")} /><Input name="evidenceRequirementIds" placeholder="ID evidence/preparation, pisahkan koma" defaultValue={value("evidenceRequirementIds")} />
        <textarea name="outcomes" className="min-h-24 rounded-md border p-2 text-sm md:col-span-2" placeholder="Learning outcomes, satu per baris: learningOutcomeId|kode|deskripsi|metode verifikasi" defaultValue={value("outcomes")} /><textarea name="simulations" className="min-h-24 rounded-md border p-2 text-sm md:col-span-2" placeholder="Simulasi internal, satu per baris: judul|instruksi|evidence latihan|durasi menit" defaultValue={value("simulations")} /><textarea name="safetyRules" className="min-h-24 rounded-md border p-2 text-sm md:col-span-2" placeholder="Aturan keselamatan, satu per baris: kode|aturan|severity|bukti verifikasi|blocking true/false" defaultValue={value("safetyRules")} />
        <div className="flex gap-2 md:col-span-2"><Button type="submit" disabled={create.isPending || update.isPending}>{editing ? "Perbarui unit" : "Tambah unit"}</Button>{editing && <Button type="button" variant="outline" onClick={() => setEditing(null)}>Batal</Button>}</div>
      </form>
    </CardContent></Card>
    {selected?.units.map(unit => <Card key={unit.id}><CardHeader><CardTitle className="flex items-center justify-between">{unit.code} · {unit.title}<Button size="sm" variant="outline" onClick={() => edit(unit)}>Edit</Button></CardTitle></CardHeader><CardContent className="grid gap-3 text-sm md:grid-cols-2"><div><strong>Learning outcomes</strong><ul className="list-disc pl-5">{(unit.outcomeMappings ?? []).map((row: any) => <li key={row.id}>{row.learningOutcomeId || "tanpa ID"} · {row.description}</li>)}</ul></div><div><strong>Practice tasks</strong><p>{(unit.practiceTaskIds ?? []).join(", ") || "—"}</p></div><div><strong>Preparation evidence</strong><p>{(unit.evidenceRequirementIds ?? []).join(", ") || "—"}</p></div><div><strong>Simulasi internal/persiapan</strong><ul className="list-disc pl-5">{(unit.simulations ?? []).map((row: any) => <li key={row.id}>{row.title} ({row.durationMinutes} menit)</li>)}</ul><p className="text-xs text-amber-700">Bukan asesmen resmi/sertifikasi.</p></div><div className="md:col-span-2"><strong>Aturan keselamatan</strong><ul className="list-disc pl-5">{(unit.safetyRules ?? []).map((row: any) => <li key={row.id}>{row.code}: {row.rule} · {row.blocking ? "blocking" : "non-blocking"}</li>)}</ul></div></CardContent></Card>)}
  </div>;
}