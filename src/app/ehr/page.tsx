"use client";

import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import {
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { format, parseISO, formatDistanceToNowStrict } from "date-fns";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

// UI
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";

// Firebase
import { initializeApp, getApps } from "firebase/app";
import {
    getFirestore,
    collection,
    limit,
    onSnapshot,
    orderBy,
    query,
    Timestamp,
} from "firebase/firestore";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";

/* ---------- Types ---------- */

export interface EHRResourceIdentifier {
    key: string;
    uid: string;
    patientId: string;
}
export enum ProcessingState {
    PROCESSING_STATE_UNSPECIFIED = "PROCESSING_STATE_UNSPECIFIED",
    PROCESSING_STATE_NOT_STARTED = "PROCESSING_STATE_NOT_STARTED",
    PROCESSING_STATE_PROCESSING = "PROCESSING_STATE_PROCESSING",
    PROCESSING_STATE_COMPLETED = "PROCESSING_STATE_COMPLETED",
    PROCESSING_STATE_FAILED = "PROCESSING_STATE_FAILED",
}
export enum FHIRVersion {
    FHIR_VERSION_UNSPECIFIED = "FHIR_VERSION_UNSPECIFIED",
    FHIR_VERSION_R4 = "FHIR_VERSION_R4",
    FHIR_VERSION_R4B = "FHIR_VERSION_R4B",
}
export interface EHRResourceMetadata {
    state: ProcessingState;
    createdTime: string;
    fetchTime: string;
    processedTime?: string;
    identifier: EHRResourceIdentifier;
    resourceType: string;
    version: FHIRVersion;
}
export interface EHRResourceJson {
    metadata: EHRResourceMetadata;
    humanReadableStr: string;
    aiSummary?: string;
}
export interface ResourceWrapper {
    id?: string; // Firestore doc id
    resource: EHRResourceJson;
}

/* ---------- Firebase ---------- */

function ensureFirebase() {
    const cfg = {
        apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    } as const;

    if (!getApps().length) initializeApp(cfg);
    return { db: getFirestore(), auth: getAuth() };
}

/* ---------- Utilities ---------- */

const stateToBadge: Record<ProcessingState, "default" | "secondary" | "destructive" | "outline"> = {
    [ProcessingState.PROCESSING_STATE_UNSPECIFIED]: "secondary",
    [ProcessingState.PROCESSING_STATE_NOT_STARTED]: "secondary",
    [ProcessingState.PROCESSING_STATE_PROCESSING]: "destructive",
    [ProcessingState.PROCESSING_STATE_COMPLETED]: "default",
    [ProcessingState.PROCESSING_STATE_FAILED]: "destructive",
};

function toISO(v?: string | Timestamp) {
    if (!v) return undefined;
    if (typeof v === "string") return v;
    if (v instanceof Timestamp) return v.toDate().toISOString();
    return undefined;
}

function pretty(iso?: string) {
    try {
        return iso ? format(parseISO(iso), "PPpp") : "—";
    } catch {
        return "—";
    }
}

function timeAgo(iso?: string) {
    try {
        return iso ? formatDistanceToNowStrict(parseISO(iso), { addSuffix: true }) : "—";
    } catch {
        return "—";
    }
}

/** Avoid hydration flicker for time-based strings. */
function useMounted() {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    return mounted;
}

/* ---------- Data hook ---------- */

function useEhrResources(demo?: boolean) {
    // Static demo data (fixed timestamps to avoid SSR/CSR drift)
    const demoRows: ResourceWrapper[] = [
        {
            id: "demo-1",
            resource: {
                metadata: {
                    state: ProcessingState.PROCESSING_STATE_COMPLETED,
                    createdTime: "2025-08-30T15:00:00.000Z",
                    fetchTime: "2025-08-30T15:05:00.000Z",
                    identifier: { key: "abc123", uid: "uid1", patientId: "patient-001" },
                    resourceType: "Observation",
                    version: FHIRVersion.FHIR_VERSION_R4,
                },
                humanReadableStr: "Blood pressure observation: 120/80 mmHg",
                aiSummary: "Normal blood pressure reading",
            },
        },
        {
            id: "demo-2",
            resource: {
                metadata: {
                    state: ProcessingState.PROCESSING_STATE_PROCESSING,
                    createdTime: "2025-08-31T13:20:00.000Z",
                    fetchTime: "2025-08-31T13:28:00.000Z",
                    identifier: { key: "def456", uid: "uid2", patientId: "patient-002" },
                    resourceType: "MedicationRequest",
                    version: FHIRVersion.FHIR_VERSION_R4B,
                },
                humanReadableStr: "Medication request for amoxicillin 500mg",
                aiSummary: "Pending pharmacist review",
            },
        },
    ];

    const { db, auth } = useMemo(() => ensureFirebase(), []);
    const [user, setUser] = useState(auth.currentUser);
    const [data, setData] = useState<ResourceWrapper[] | null>(null);
    const [loading, setLoading] = useState(true);

    // Keep hooks order stable; branch logic inside effects.
    useEffect(() => {
        const unsub = onAuthStateChanged(auth, setUser);
        return () => unsub();
    }, [auth]);

    useEffect(() => {
        if (demo) {
            setData(demoRows);
            setLoading(false);
            return;
        }
        if (!user) {
            setData([]);
            setLoading(false);
            return;
        }

        const q = query(
            collection(db, "ehr_resources"),
            orderBy("resource.metadata.createdTime", "desc"),
            limit(500)
        );

        const unsub = onSnapshot(q, (snap) => {
            const rows = snap.docs.map((d) => {
                const raw = d.data() as any;
                const created = toISO(raw?.resource?.metadata?.createdTime);
                const fetched = toISO(raw?.resource?.metadata?.fetchTime);
                const processed = toISO(raw?.resource?.metadata?.processedTime);
                return {
                    id: d.id,
                    resource: {
                        ...raw.resource,
                        metadata: {
                            ...raw.resource?.metadata,
                            createdTime: created ?? raw.resource?.metadata?.createdTime,
                            fetchTime: fetched ?? raw.resource?.metadata?.fetchTime,
                            processedTime: processed ?? raw.resource?.metadata?.processedTime,
                        },
                    },
                } as ResourceWrapper;
            });
            setData(rows);
            setLoading(false);
        });

        return () => unsub();
    }, [db, user, demo]);

    const signIn = async () => signInWithPopup(auth, new GoogleAuthProvider());
    const logOut = async () => signOut(auth);

    if (demo) {
        return {
            data: data ?? demoRows,
            loading: false,
            user: { email: "demo@localhost" } as any,
            signIn: async () => { },
            logOut: async () => { },
        } as const;
    }

    return { data: data ?? [], loading, user, signIn, logOut } as const;
}

/* ---------- Table columns ---------- */

function makeColumns(showLiveTime: boolean): ColumnDef<ResourceWrapper>[] {
    return [
        {
            accessorKey: "resource.metadata.resourceType",
            header: "Resource Type",
            cell: ({ row }) => (
                <span className="font-medium">{row.original.resource.metadata.resourceType}</span>
            ),
        },
        {
            accessorKey: "resource.metadata.identifier.patientId",
            header: "Patient",
            cell: ({ row }) => (
                <span className="text-muted-foreground">
                    {row.original.resource.metadata.identifier?.patientId ?? "—"}
                </span>
            ),
        },
        {
            id: "created",
            header: "Created",
            cell: ({ row }) => {
                const iso = row.original.resource.metadata.createdTime;
                return (
                    <div className="flex flex-col">
                        <span className="text-sm">{showLiveTime ? timeAgo(iso) : "\u00A0"}</span>
                        <span className="text-xs text-muted-foreground">{pretty(iso)}</span>
                    </div>
                );
            },
            sortingFn: (a, b) =>
                Date.parse(a.original.resource.metadata.createdTime ?? "") -
                Date.parse(b.original.resource.metadata.createdTime ?? ""),
        },
        {
            id: "fetched",
            header: "Fetched",
            cell: ({ row }) => {
                const iso = row.original.resource.metadata.fetchTime;
                return (
                    <div className="flex flex-col">
                        <span className="text-sm">{showLiveTime ? timeAgo(iso) : "\u00A0"}</span>
                        <span className="text-xs text-muted-foreground">{pretty(iso)}</span>
                    </div>
                );
            },
            sortingFn: (a, b) =>
                Date.parse(a.original.resource.metadata.fetchTime ?? "") -
                Date.parse(b.original.resource.metadata.fetchTime ?? ""),
        },
        {
            accessorKey: "resource.metadata.state",
            header: "State",
            cell: ({ row }) => {
                const s = row.original.resource.metadata.state;
                const label = s.replace("PROCESSING_STATE_", "").replaceAll("_", " ");
                return <Badge variant={stateToBadge[s]}>{label}</Badge>;
            },
        },
        {
            id: "details",
            header: "Details",
            cell: ({ row }) => <DetailSheet row={row.original} showLiveTime={showLiveTime} />,
            enableSorting: false,
        },
    ];
}

/* ---------- Components ---------- */

function DataTable<TData, TValue>({
    columns,
    data,
}: {
    columns: ColumnDef<TData, TValue>[];
    data: TData[];
}) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [globalFilter, setGlobalFilter] = useState("");

    const table = useReactTable({
        data,
        columns,
        state: { sorting, globalFilter },
        onSortingChange: setSorting,
        onGlobalFilterChange: setGlobalFilter,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
    });

    return (
        <Card className="w-full">
            <CardHeader className="gap-2">
                <CardTitle className="text-xl">EHR Resources</CardTitle>
                <div className="flex items-center gap-2">
                    <Input
                        placeholder="Search…"
                        value={globalFilter ?? ""}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        className="max-w-sm"
                        aria-label="Search resources"
                    />
                    <div className="ml-auto text-sm text-muted-foreground">
                        {table.getFilteredRowModel().rows.length} results
                    </div>
                </div>
            </CardHeader>

            <CardContent>
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((hg) => (
                            <TableRow key={hg.id}>
                                {hg.headers.map((header) => (
                                    <TableHead key={header.id} className="whitespace-nowrap">
                                        {header.isPlaceholder ? null : (
                                            <div
                                                className={header.column.getCanSort() ? "cursor-pointer select-none" : ""}
                                                onClick={header.column.getToggleSortingHandler()}
                                                role={header.column.getCanSort() ? "button" : undefined}
                                                aria-label={`Sort by ${String(header.column.id)}`}
                                            >
                                                {flexRender(header.column.columnDef.header, header.getContext())}
                                                {{ asc: " ▲", desc: " ▼" }[header.column.getIsSorted() as string] ?? null}
                                            </div>
                                        )}
                                    </TableHead>
                                ))}
                            </TableRow>
                        ))}
                    </TableHeader>

                    <TableBody>
                        {table.getRowModel().rows.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow key={row.id} className="hover:bg-muted/50">
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id} className="align-top">
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center">
                                    No results
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>

                <div className="flex items-center justify-between pt-4">
                    <div className="text-sm text-muted-foreground">
                        Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount() || 1}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            <ChevronLeft className="h-4 w-4" /> Prev
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            Next <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

function DetailSheet({ row, showLiveTime }: { row: ResourceWrapper; showLiveTime: boolean }) {
    const m = row.resource.metadata;

    return (
        <Sheet>
            <SheetTrigger asChild>
                <Button variant="ghost" className="w-full justify-start" aria-label="Open details">
                    Open
                </Button>
            </SheetTrigger>

            <SheetContent className="w-full sm:max-w-2xl overflow-y-auto p-6">
                <SheetHeader>
                    <SheetTitle className="text-lg font-semibold">{m.resourceType}</SheetTitle>
                    <SheetDescription className="text-sm text-muted-foreground">
                        FHIR {m.version} • State: {m.state}
                    </SheetDescription>
                </SheetHeader>

                <div className="py-6 space-y-6">
                    <div className="grid gap-4">
                        <Field label="Created">
                            {pretty(m.createdTime)} {showLiveTime ? `(${timeAgo(m.createdTime)})` : ""}
                        </Field>
                        <Field label="Fetched">
                            {pretty(m.fetchTime)} {showLiveTime ? `(${timeAgo(m.fetchTime)})` : ""}
                        </Field>
                        {m.processedTime && (
                            <Field label="Processed">
                                {pretty(m.processedTime)} {showLiveTime ? `(${timeAgo(m.processedTime)})` : ""}
                            </Field>
                        )}
                    </div>

                    <Separator />

                    <div className="grid grid-cols-3 gap-4">
                        <KV label="Key" value={m.identifier?.key} mono />
                        <KV label="UID" value={m.identifier?.uid} mono />
                        <KV label="Patient ID" value={m.identifier?.patientId} mono />
                    </div>

                    <Separator />

                    <Block label="Human Readable" text={row.resource.humanReadableStr} />
                    {row.resource.aiSummary && <Block label="AI Summary" text={row.resource.aiSummary} />}
                </div>
            </SheetContent>
        </Sheet>
    );
}

/* Small, readable subcomponents */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="text-xs uppercase text-muted-foreground">{label}</div>
            <div className="text-sm">{children}</div>
        </div>
    );
}

function KV({ label, value, mono = false }: { label: string; value?: string; mono?: boolean }) {
    return (
        <div>
            <div className="text-xs uppercase text-muted-foreground">{label}</div>
            <div className={`text-sm break-all ${mono ? "font-mono" : ""}`}>{value ?? "—"}</div>
        </div>
    );
}

function Block({ label, text }: { label: string; text?: string }) {
    return (
        <div>
            <div className="text-sm font-semibold mb-2">{label}</div>
            <pre className="text-sm bg-muted p-4 rounded-lg whitespace-pre-wrap break-words">
                {text || "—"}
            </pre>
        </div>
    );
}

/* ---------- Page ---------- */

export default function EHRResourcesPage() {
    const mounted = useMounted();
    const sp = useSearchParams();

    // Support both env and ?demo=1; only read the query param after mount to avoid SSR warnings.
    const demo = process.env.NEXT_PUBLIC_DEMO === "1" || (mounted && sp.get("demo") === "1");

    const { data, loading, user, signIn, logOut } = useEhrResources(demo);
    const columns = makeColumns(mounted);

    return (
        <div className="container mx-auto max-w-6xl p-6 space-y-4">
            <header className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">EHR Resource Viewer</h1>
                <div className="ml-auto flex items-center gap-2">
                    {!mounted ? null : user ? (
                        <>
                            <span className="text-sm text-muted-foreground">{user.email}</span>
                            <Button variant="outline" size="sm" onClick={logOut}>
                                Sign out
                            </Button>
                        </>
                    ) : (
                        <Button size="sm" onClick={signIn}>
                            Sign in with Google
                        </Button>
                    )}
                </div>
            </header>

            {loading ? (
                <Card>
                    <CardContent className="p-6 space-y-3">
                        <div className="flex items-center gap-3">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span>Loading…</span>
                        </div>
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-5/6" />
                        <Skeleton className="h-8 w-3/4" />
                    </CardContent>
                </Card>
            ) : (
                <DataTable columns={columns} data={data} />
            )}

            <footer className="text-xs text-muted-foreground pt-2">
                Showing: <code>resourceType</code>, <code>createdTime</code>, <code>fetchTime</code> (relative),{" "}
                <code>state</code>. Open <em>Details</em> for <code>humanReadableStr</code>,{" "}
                <code>aiSummary</code>, and identifiers.
            </footer>
        </div>
    );
}