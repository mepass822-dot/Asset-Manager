import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListWallets, useRunAgent,
  getListAgentLogsQueryKey, getGetAgentStatsQueryKey,
  getGetSchedulerQueryKey, getGetSweepConfigQueryKey, getSweepConfig,
} from "@workspace/api-client-react";
import { authFetch } from "@/lib/firebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Play, Bot, Terminal, Clock, StopCircle, Timer, Shuffle, ShieldCheck, Coins, RefreshCw, Save, Eye, CheckSquare, Zap, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { AgentRunResult, AgentLog, SweepConfig } from "@workspace/api-client-react";

const INTERVALS = [
  { label: "Every 15 min", ms: 15 * 60 * 1000 },
  { label: "Every 30 min", ms: 30 * 60 * 1000 },
  { label: "Every 1 hour", ms: 60 * 60 * 1000 },
  { label: "Every 2 hours", ms: 2 * 60 * 60 * 1000 },
  { label: "Every 4 hours", ms: 4 * 60 * 60 * 1000 },
  { label: "Every 12 hours", ms: 12 * 60 * 60 * 1000 },
  { label: "Every 24 hours", ms: 24 * 60 * 60 * 1000 },
];

function formatRelative(dateStr: string | null | undefined) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  const hrs = Math.floor(abs / 3600000);
  if (hrs > 0) return `${diff < 0 ? "" : "in "}${hrs}h ${Math.floor((abs % 3600000) / 60000)}m${diff < 0 ? " ago" : ""}`;
  return `${diff < 0 ? "" : "in "}${mins}m${diff < 0 ? " ago" : ""}`;
}

export default function Agent() {
  const { data: wallets, isLoading: walletsLoading } = useListWallets();
  const runAgent = useRunAgent();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [selectedWallets, setSelectedWallets] = useState<Set<number>>(new Set());
  const [masterPassword, setMasterPassword] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState<AgentRunResult | null>(null);

  // Sweep config state
  const { data: sweepConfig, refetch: refetchSweepConfig } = useQuery({
    queryKey: getGetSweepConfigQueryKey(),
    queryFn: () => getSweepConfig(),
    refetchInterval: 30_000,
  });
  const [sweepMasterAddress, setSweepMasterAddress] = useState("");
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [sweepAutoClaimStaking, setSweepAutoClaimStaking] = useState(true);
  const [sweepDividendWindowDays, setSweepDividendWindowDays] = useState(7);
  const [sweepMinAmount, setSweepMinAmount] = useState("1");
  const [sweepEditing, setSweepEditing] = useState(false);

  // Sweep Now state
  const [sweepNowPassword, setSweepNowPassword] = useState("");
  const [sweepNowDryRun, setSweepNowDryRun] = useState(false);
  const [sweepNowResult, setSweepNowResult] = useState<{ swept: number; skipped: number; dryRun: boolean; masterAddress: string; logs: AgentLog[] } | null>(null);

  const sweepNow = useMutation({
    mutationFn: (body: object) =>
      authFetch("/api/agent/sweep-now", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
        if (!r.ok) { const d = await r.json(); throw new Error(d.error || "Sweep failed"); }
        return r.json();
      }),
    onSuccess: (data: { swept: number; skipped: number; dryRun: boolean; masterAddress: string; logs: AgentLog[] }) => {
      setSweepNowResult(data);
      queryClient.invalidateQueries({ queryKey: getListAgentLogsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAgentStatsQueryKey() });
      toast({ title: data.dryRun ? "Dry Run Complete" : "Sweep Complete", description: `${data.swept} wallet(s) swept, ${data.skipped} skipped.` });
    },
    onError: (err: any) => toast({ title: "Sweep failed", description: err?.message ?? "Unknown error", variant: "destructive" }),
  });

  const saveSweepConfig = useMutation({
    mutationFn: (body: object) =>
      authFetch("/api/agent/sweep-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()),
    onSuccess: () => {
      refetchSweepConfig();
      setSweepEditing(false);
      toast({ title: "Sweep config saved" });
    },
    onError: () => toast({ title: "Failed to save sweep config", variant: "destructive" }),
  });

  const handleEditSweep = (cfg: SweepConfig) => {
    setSweepMasterAddress(cfg.masterAddress);
    setSweepEnabled(cfg.enabled);
    setSweepAutoClaimStaking(cfg.autoClaimStaking);
    setSweepDividendWindowDays(cfg.dividendWindowDays);
    setSweepMinAmount(cfg.minSweepAmountMec);
    setSweepEditing(true);
  };

  // Scheduler state
  const [schedWallets, setSchedWallets] = useState<Set<number>>(new Set());
  const [useMonitoredForSched, setUseMonitoredForSched] = useState(false);
  const [schedPassword, setSchedPassword] = useState("");
  const [schedInterval, setSchedInterval] = useState(String(INTERVALS[2].ms));
  const [schedDryRun, setSchedDryRun] = useState(true);

  const { data: scheduler, refetch: refetchScheduler } = useQuery({
    queryKey: getGetSchedulerQueryKey(),
    queryFn: () => authFetch("/api/agent/scheduler").then(r => r.json()),
    refetchInterval: 5000,
  });

  const startSched = useMutation({
    mutationFn: (body: object) =>
      authFetch("/api/agent/scheduler", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()),
    onSuccess: () => {
      refetchScheduler();
      toast({ title: "Scheduler started", description: "Agent will run automatically on schedule." });
    },
    onError: (err: any) => toast({ title: "Failed to start scheduler", description: err?.message ?? "Check configuration.", variant: "destructive" }),
  });

  const stopSched = useMutation({
    mutationFn: () => authFetch("/api/agent/scheduler", { method: "DELETE" }).then(r => r.json()),
    onSuccess: () => {
      refetchScheduler();
      toast({ title: "Scheduler stopped" });
    },
  });

  const toggleWallet = (id: number) => {
    const s = new Set(selectedWallets);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedWallets(s);
  };

  const toggleSchedWallet = (id: number) => {
    if (useMonitoredForSched) return;
    const s = new Set(schedWallets);
    s.has(id) ? s.delete(id) : s.add(id);
    setSchedWallets(s);
  };

  // Helpers
  const monitoredWallets = wallets?.filter((w: any) => w.monitored) ?? [];
  const monitoredIds = new Set(monitoredWallets.map((w: any) => w.id));

  const selectAllManual = () => setSelectedWallets(new Set(wallets?.map(w => w.id) ?? []));
  const selectMonitoredManual = () => setSelectedWallets(new Set(monitoredWallets.map((w: any) => w.id)));
  const selectAllSched = () => setSchedWallets(new Set(wallets?.map(w => w.id) ?? []));

  const handleRun = () => {
    setResult(null);
    runAgent.mutate(
      { data: { walletIds: Array.from(selectedWallets), masterPassword, dryRun } },
      {
        onSuccess: (data) => {
          setResult(data);
          queryClient.invalidateQueries({ queryKey: getListAgentLogsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAgentStatsQueryKey() });
          toast({ title: "Agent Run Complete", description: `Executed: ${data.executed}, Skipped: ${data.skipped}` });
        },
        onError: () => toast({ title: "Agent Run Failed", description: "Check password or connection.", variant: "destructive" }),
      }
    );
  };

  const handleStartScheduler = () => {
    if (!schedPassword) return;
    const body: any = {
      intervalMs: Number(schedInterval),
      masterPassword: schedPassword,
      dryRun: schedDryRun,
    };
    if (useMonitoredForSched) {
      body.useMonitoredWallets = true;
    } else {
      if (schedWallets.size === 0) return;
      body.walletIds = Array.from(schedWallets);
    }
    startSched.mutate(body);
  };

  const isSchedulerRunning = scheduler?.enabled === true;
  const schedCanStart = !!schedPassword && (useMonitoredForSched ? monitoredWallets.length > 0 : schedWallets.size > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Run Agent</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Execute automated operations across selected wallets.
        </p>
      </div>

      {/* Sweep Config Card */}
      <Card className="border-border/50 bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Shuffle className="h-5 w-5 text-primary" />
            Auto-Sweep &amp; Staking Config
            {sweepConfig?.enabled ? (
              <Badge className="ml-2 bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">ENABLED</Badge>
            ) : (
              <Badge variant="outline" className="ml-2 text-xs text-muted-foreground">DISABLED</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sweepEditing ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Master Sweep Address</Label>
                  <Input
                    value={sweepMasterAddress}
                    onChange={e => setSweepMasterAddress(e.target.value)}
                    className="font-mono text-xs"
                    placeholder="me1..."
                  />
                  <p className="text-xs text-muted-foreground">All dividend and staking rewards will be swept to this address.</p>
                </div>
                <div className="space-y-2">
                  <Label>Dividend Window (days 1–N of each month)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={15}
                    value={sweepDividendWindowDays}
                    onChange={e => setSweepDividendWindowDays(Number(e.target.value))}
                  />
                  <p className="text-xs text-muted-foreground">Agent treats the first N days of each month as the dividend window and auto-sweeps.</p>
                </div>
                <div className="space-y-2">
                  <Label>Min Sweep Amount (MEC)</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.1"
                    value={sweepMinAmount}
                    onChange={e => setSweepMinAmount(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border border-border/50 p-3">
                  <div>
                    <Label className="flex items-center gap-1"><Shuffle className="h-3.5 w-3.5" /> Auto-Sweep Enabled</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">Sweep verified wallets → master address during dividend window</p>
                  </div>
                  <Switch checked={sweepEnabled} onCheckedChange={setSweepEnabled} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/50 p-3">
                  <div>
                    <Label className="flex items-center gap-1"><Coins className="h-3.5 w-3.5 text-amber-400" /> Auto-Claim Staking Rewards</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">Claim block rewards before sweep on every run</p>
                  </div>
                  <Switch checked={sweepAutoClaimStaking} onCheckedChange={setSweepAutoClaimStaking} />
                </div>
                <div className="flex gap-2 mt-2">
                  <Button
                    className="flex-1 gap-2"
                    disabled={saveSweepConfig.isPending}
                    onClick={() => saveSweepConfig.mutate({
                      masterAddress: sweepMasterAddress,
                      enabled: sweepEnabled,
                      autoClaimStaking: sweepAutoClaimStaking,
                      dividendWindowDays: sweepDividendWindowDays,
                      minSweepAmountMec: sweepMinAmount,
                    })}
                  >
                    {saveSweepConfig.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save Config
                  </Button>
                  <Button variant="outline" onClick={() => setSweepEditing(false)}>Cancel</Button>
                </div>
              </div>
            </div>
          ) : sweepConfig ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-background/60 rounded-lg p-3 border border-border/40">
                  <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Master Address</div>
                  <div className="font-mono text-xs font-semibold truncate" title={sweepConfig.masterAddress}>
                    {sweepConfig.masterAddress.slice(0, 10)}…{sweepConfig.masterAddress.slice(-6)}
                  </div>
                </div>
                <div className="bg-background/60 rounded-lg p-3 border border-border/40">
                  <div className="text-xs text-muted-foreground mb-1">Dividend Window</div>
                  <div className="font-semibold">Days 1–{sweepConfig.dividendWindowDays}</div>
                </div>
                <div className="bg-background/60 rounded-lg p-3 border border-border/40">
                  <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Coins className="h-3 w-3 text-amber-400" /> Auto Claim Staking</div>
                  <div className="font-semibold">{sweepConfig.autoClaimStaking ? "Yes" : "No"}</div>
                </div>
                <div className="bg-background/60 rounded-lg p-3 border border-border/40">
                  <div className="text-xs text-muted-foreground mb-1">Min Sweep</div>
                  <div className="font-semibold">{sweepConfig.minSweepAmountMec} MEC</div>
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => handleEditSweep(sweepConfig)} className="gap-2">
                Edit Config
              </Button>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" /> Loading sweep config…
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sweep Now Card */}
      <Card className="border-2 border-primary/40 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            Sweep Now
            <span className="text-xs font-normal text-muted-foreground ml-1">— instantly sweep all verified wallets to master address</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sweepNowResult ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-emerald-400">{sweepNowResult.swept}</div>
                  <div className="text-xs text-muted-foreground mt-1">{sweepNowResult.dryRun ? "Would Sweep" : "Swept"}</div>
                </div>
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-yellow-400">{sweepNowResult.skipped}</div>
                  <div className="text-xs text-muted-foreground mt-1">Skipped</div>
                </div>
                <div className="bg-background/60 border border-border/40 rounded-lg p-3 text-center">
                  <div className="text-xs font-mono font-semibold text-primary truncate">{sweepNowResult.masterAddress.slice(0, 10)}…</div>
                  <div className="text-xs text-muted-foreground mt-1">Master Address</div>
                </div>
              </div>
              {sweepNowResult.logs.length > 0 && (
                <ScrollArea className="h-[180px] border border-border/40 rounded-md p-3 bg-black/30 font-mono text-xs">
                  {sweepNowResult.logs.map((log: AgentLog, i: number) => (
                    <div key={i} className="mb-2 pb-2 border-b border-border/20 last:border-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={log.status === "success" ? "default" : log.status === "error" ? "destructive" : "secondary"} className="text-[10px] h-4 py-0">{log.status}</Badge>
                        <span className="text-primary/80 font-semibold">{log.action}</span>
                        {log.txHash && <span className="text-muted-foreground">TX: {log.txHash.slice(0, 12)}…</span>}
                      </div>
                      <div className="text-foreground/70 mt-1">{log.message}</div>
                    </div>
                  ))}
                </ScrollArea>
              )}
              <Button variant="outline" size="sm" onClick={() => setSweepNowResult(null)} className="w-full">Run Again</Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>This will immediately:</p>
                  <ul className="ml-4 space-y-0.5 list-disc text-foreground/70">
                    <li>Check every verified wallet's balance</li>
                    {sweepConfig?.autoClaimStaking && <li>Claim any pending staking rewards</li>}
                    <li>Sweep balances above <span className="text-primary font-mono">{sweepConfig?.minSweepAmountMec ?? "0.001"} MEC</span> → master address</li>
                  </ul>
                </div>
                <div className="bg-background/60 rounded-lg border border-border/40 p-2 font-mono text-xs text-muted-foreground flex items-center gap-2">
                  <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                  <span className="truncate" title={sweepConfig?.masterAddress}>{sweepConfig?.masterAddress ?? "Loading…"}</span>
                </div>
              </div>
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Master Password</Label>
                  <Input
                    type="password"
                    value={sweepNowPassword}
                    onChange={e => setSweepNowPassword(e.target.value)}
                    placeholder="Unlock wallets for sweep..."
                  />
                  <p className="text-xs text-muted-foreground">Used to decrypt wallet keys — never stored.</p>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Dry Run</Label>
                    <p className="text-xs text-muted-foreground">Preview without broadcasting TXs</p>
                  </div>
                  <Switch checked={sweepNowDryRun} onCheckedChange={setSweepNowDryRun} />
                </div>
                <Button
                  className={`w-full gap-2 font-bold ${!sweepNowDryRun ? "bg-primary hover:bg-primary/90" : ""}`}
                  variant={sweepNowDryRun ? "secondary" : "default"}
                  disabled={sweepNow.isPending || !sweepNowPassword}
                  onClick={() => sweepNow.mutate({ masterPassword: sweepNowPassword, dryRun: sweepNowDryRun })}
                >
                  {sweepNow.isPending
                    ? <><RefreshCw className="h-4 w-4 animate-spin" /> Sweeping...</>
                    : <><Zap className="h-4 w-4" /> {sweepNowDryRun ? "Preview Sweep" : "Execute Sweep Now"}</>
                  }
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Scheduler Card */}
      <Card className={`border-2 ${isSchedulerRunning ? "border-primary/50 bg-primary/5" : "border-border/50 bg-card"}`}>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Timer className="h-5 w-5 text-primary" />
            Auto Scheduler
            {isSchedulerRunning ? (
              <Badge className="ml-2 bg-primary/20 text-primary border-primary/30 text-xs">RUNNING</Badge>
            ) : (
              <Badge variant="outline" className="ml-2 text-xs text-muted-foreground">STOPPED</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isSchedulerRunning ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-background/60 rounded-lg p-3 border border-border/40">
                  <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Clock className="h-3 w-3" /> Interval</div>
                  <div className="font-semibold">{INTERVALS.find(i => i.ms === scheduler?.intervalMs)?.label ?? `${Math.round((scheduler?.intervalMs ?? 0) / 60000)}m`}</div>
                </div>
                <div className="bg-background/60 rounded-lg p-3 border border-border/40">
                  <div className="text-xs text-muted-foreground mb-1">Next Run</div>
                  <div className="font-semibold text-primary">{formatRelative(scheduler?.nextRunAt)}</div>
                </div>
                <div className="bg-background/60 rounded-lg p-3 border border-border/40">
                  <div className="text-xs text-muted-foreground mb-1">Last Run</div>
                  <div className="font-semibold">{scheduler?.lastRunAt ? formatRelative(scheduler.lastRunAt) : "—"}</div>
                </div>
                <div className="bg-background/60 rounded-lg p-3 border border-border/40">
                  <div className="text-xs text-muted-foreground mb-1">Last Result</div>
                  <div className="font-semibold">
                    {scheduler?.lastRunResult
                      ? `${scheduler.lastRunResult.executed} exec / ${scheduler.lastRunResult.skipped} skip`
                      : "Pending first run"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span>{scheduler?.walletIds?.length ?? 0} wallet(s) • {scheduler?.dryRun ? "Dry run mode" : "Live mode"}</span>
                <Button
                  size="sm"
                  variant="destructive"
                  className="ml-auto gap-2"
                  onClick={() => stopSched.mutate()}
                  disabled={stopSched.isPending}
                >
                  <StopCircle className="h-4 w-4" /> Stop Scheduler
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                {/* Wallet selection mode toggle */}
                <div className="flex items-center justify-between rounded-lg border border-border/50 p-3">
                  <div>
                    <Label className="flex items-center gap-1"><Eye className="h-3.5 w-3.5 text-blue-400" /> Use Monitored Wallets</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Auto-select all wallets marked as monitored
                      {monitoredWallets.length > 0 && <span className="text-blue-400 ml-1">({monitoredWallets.length} active)</span>}
                    </p>
                  </div>
                  <Switch checked={useMonitoredForSched} onCheckedChange={setUseMonitoredForSched} />
                </div>

                {!useMonitoredForSched && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Wallets to Monitor</Label>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs gap-1 text-muted-foreground"
                          onClick={selectAllSched}
                        >
                          <CheckSquare className="h-3 w-3" /> All
                        </Button>
                        {monitoredWallets.length > 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs gap-1 text-blue-400"
                            onClick={() => setSchedWallets(new Set(monitoredWallets.map((w: any) => w.id)))}
                          >
                            <Eye className="h-3 w-3" /> Monitored
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="space-y-2 max-h-[140px] overflow-auto border border-border/50 rounded-md p-2">
                      {walletsLoading ? (
                        <div className="text-sm text-muted-foreground">Loading...</div>
                      ) : wallets?.length === 0 ? (
                        <div className="text-sm text-muted-foreground">No wallets.</div>
                      ) : (
                        wallets?.map((w: any) => (
                          <div key={w.id} className="flex items-center space-x-2">
                            <Checkbox id={`sw-${w.id}`} checked={schedWallets.has(w.id)} onCheckedChange={() => toggleSchedWallet(w.id)} />
                            <label htmlFor={`sw-${w.id}`} className="text-sm font-medium leading-none cursor-pointer flex items-center gap-1">
                              {w.label}
                              <span className="text-muted-foreground font-mono text-xs">({w.address.slice(0, 6)}...)</span>
                              {w.monitored && <Eye className="h-3 w-3 text-blue-400" />}
                            </label>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {useMonitoredForSched && monitoredWallets.length > 0 && (
                  <div className="space-y-1 border border-blue-500/20 bg-blue-500/5 rounded-md p-2 max-h-[120px] overflow-auto">
                    {monitoredWallets.map((w: any) => (
                      <div key={w.id} className="flex items-center gap-2 text-sm">
                        <Eye className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                        <span className="font-medium">{w.label}</span>
                        <span className="text-muted-foreground font-mono text-xs">({w.address.slice(0, 6)}...)</span>
                      </div>
                    ))}
                  </div>
                )}

                {useMonitoredForSched && monitoredWallets.length === 0 && (
                  <div className="text-sm text-amber-400 border border-amber-500/30 bg-amber-500/5 rounded-md p-3">
                    No wallets are marked as monitored. Go to the Wallets page and toggle the eye icon on any wallet, or select wallets and click "Monitor All".
                  </div>
                )}

                <div className="space-y-2">
                  <Label>Run Interval</Label>
                  <Select value={schedInterval} onValueChange={setSchedInterval}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {INTERVALS.map(i => (
                        <SelectItem key={i.ms} value={String(i.ms)}>{i.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Master Password</Label>
                  <Input
                    type="password"
                    value={schedPassword}
                    onChange={e => setSchedPassword(e.target.value)}
                    placeholder="Unlock wallets for auto-runs..."
                  />
                  <p className="text-xs text-muted-foreground">Stored in memory only — clears on server restart.</p>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Dry Run Mode</Label>
                    <p className="text-xs text-muted-foreground">Simulate without signing TXs</p>
                  </div>
                  <Switch checked={schedDryRun} onCheckedChange={setSchedDryRun} />
                </div>
                <Button
                  className="w-full gap-2 font-bold"
                  onClick={handleStartScheduler}
                  disabled={startSched.isPending || !schedCanStart}
                >
                  <Timer className="h-4 w-4" />
                  {startSched.isPending ? "Starting..." : "Start Scheduler"}
                </Button>
                {!schedCanStart && schedPassword && (
                  <p className="text-xs text-amber-400">
                    {useMonitoredForSched
                      ? "Mark at least one wallet as monitored first."
                      : "Select at least one wallet."}
                  </p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Manual Run */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1 space-y-6">
          <Card className="bg-card border-border/50">
            <CardHeader>
              <CardTitle className="text-lg">Manual Run</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Target Wallets</Label>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs gap-1 text-muted-foreground"
                      onClick={selectAllManual}
                    >
                      <CheckSquare className="h-3 w-3" /> All
                    </Button>
                    {monitoredWallets.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs gap-1 text-blue-400"
                        onClick={selectMonitoredManual}
                      >
                        <Eye className="h-3 w-3" /> Monitored
                      </Button>
                    )}
                  </div>
                </div>
                <div className="space-y-2 max-h-[200px] overflow-auto border border-border/50 rounded-md p-2">
                  {walletsLoading ? (
                    <div className="text-sm text-muted-foreground">Loading wallets...</div>
                  ) : wallets?.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No wallets available.</div>
                  ) : (
                    wallets?.map((w: any) => (
                      <div key={w.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`wallet-${w.id}`}
                          checked={selectedWallets.has(w.id)}
                          onCheckedChange={() => toggleWallet(w.id)}
                        />
                        <label htmlFor={`wallet-${w.id}`} className="text-sm font-medium leading-none cursor-pointer flex items-center gap-1">
                          {w.label}
                          <span className="text-muted-foreground font-mono text-xs">({w.address.slice(0, 6)}...)</span>
                          {w.monitored && <Eye className="h-3 w-3 text-blue-400" />}
                        </label>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="masterPassword">Master Password</Label>
                <Input
                  id="masterPassword"
                  type="password"
                  value={masterPassword}
                  onChange={e => setMasterPassword(e.target.value)}
                  placeholder="Unlock wallets..."
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Dry Run Mode</Label>
                  <p className="text-xs text-muted-foreground">Simulate without signing TXs</p>
                </div>
                <Switch checked={dryRun} onCheckedChange={setDryRun} />
              </div>
              <Button
                className="w-full gap-2 font-bold"
                size="lg"
                disabled={runAgent.isPending || selectedWallets.size === 0 || !masterPassword}
                onClick={handleRun}
                variant={dryRun ? "secondary" : "default"}
              >
                {runAgent.isPending ? <Bot className="h-4 w-4 animate-bounce" /> : <Play className="h-4 w-4" />}
                {runAgent.isPending ? "Executing..." : dryRun ? "Simulate Run" : "Execute Live"}
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="md:col-span-2">
          <Card className="bg-card border-border/50 h-full flex flex-col">
            <CardHeader className="border-b border-border/50">
              <CardTitle className="text-lg flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="h-5 w-5 text-primary" /> Output
                </div>
                {result && (
                  <div className="flex gap-2">
                    <Badge variant="outline">Executed: {result.executed}</Badge>
                    <Badge variant="outline">Skipped: {result.skipped}</Badge>
                  </div>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex-1 relative bg-black/40">
              <ScrollArea className="h-[400px] md:h-full p-4 font-mono text-sm">
                {!result && !runAgent.isPending && (
                  <div className="text-muted-foreground/50 h-full flex items-center justify-center italic">
                    Awaiting execution...
                  </div>
                )}
                {runAgent.isPending && (
                  <div className="text-primary flex items-center gap-2 animate-pulse">
                    <Bot className="h-4 w-4" /> Agent is analyzing and executing...
                  </div>
                )}
                {(result?.logs ?? []).map((log: AgentLog, i) => (
                  <div key={i} className="mb-3 flex flex-col gap-1 border-b border-border/20 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">[{new Date(log.createdAt).toLocaleTimeString()}]</span>
                      <span className="text-primary/80">[{log.walletLabel}]</span>
                      <Badge variant={log.status === "success" ? "default" : log.status === "error" ? "destructive" : "secondary"} className="text-[10px] h-4 py-0">
                        {log.status}
                      </Badge>
                      <span className="font-bold">{log.action}</span>
                    </div>
                    <div className="pl-[140px] text-foreground/80">{log.message}</div>
                    {log.txHash && <div className="pl-[140px] text-xs text-muted-foreground">TX: {log.txHash}</div>}
                  </div>
                ))}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
