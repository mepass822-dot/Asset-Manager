import { useState } from "react";
import { useListWallets, listAgentLogs, getListAgentLogsQueryKey } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/firebase";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, ExternalLink, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const STATUS_VARIANTS: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; className: string }> = {
  success:   { variant: "default",     className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  error:     { variant: "destructive", className: "" },
  dry_run:   { variant: "secondary",   className: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  blocked:   { variant: "outline",     className: "text-orange-400 border-orange-500/40 bg-orange-500/10" },
  pending:   { variant: "outline",     className: "text-muted-foreground" },
};

const ACTION_LABELS: Record<string, string> = {
  sweep_balance:       "Sweep",
  sweep_dividend:      "Dividend Sweep",
  claim_staking_rewards: "Claim Staking",
  agent_run:           "Agent Run",
  send:                "Send",
  scheduled_run:       "Scheduled Run",
  balance_alert:       "Alert",
};

const RPC_EXPLORER = "http://118.175.0.247:16657/tx?hash=0x";

export default function Logs() {
  const [walletId, setWalletId] = useState<string>("all");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: wallets } = useListWallets();
  const logsParams = walletId !== "all" ? { walletId: parseInt(walletId) } : undefined;
  const { data: rawLogs, isLoading, refetch, isFetching } = useQuery({
    queryKey: getListAgentLogsQueryKey(logsParams),
    queryFn: () => listAgentLogs(logsParams),
    refetchInterval: 10_000,
  });
  const logs = Array.isArray(rawLogs) ? rawLogs : [];

  const clearLogs = useMutation({
    mutationFn: () =>
      authFetch("/api/agent/logs", { method: "DELETE" }).then(async (r) => {
        if (!r.ok) { const d = await r.json(); throw new Error(d.error || "Failed to clear logs"); }
        return r.json();
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListAgentLogsQueryKey() });
      toast({ title: "Logs cleared" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Activity Logs</h1>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              Live · refreshes every 10s
            </div>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">Complete audit trail of all agent operations.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={walletId} onValueChange={setWalletId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Filter by Wallet" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Wallets</SelectItem>
              {wallets?.map((w: { id: number; label: string }) => (
                <SelectItem key={w.id} value={w.id.toString()}>{w.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh now"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 gap-1.5"
            onClick={() => clearLogs.mutate()}
            disabled={clearLogs.isPending || logs.length === 0}
            title="Clear all logs"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </div>

      {/* Summary badges */}
      {logs.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {(["success", "error", "blocked", "dry_run"] as const).map((status) => {
            const count = logs.filter((l: { status: string }) => l.status === status).length;
            if (!count) return null;
            const cfg = STATUS_VARIANTS[status];
            return (
              <Badge key={status} variant={cfg.variant} className={`text-xs ${cfg.className}`}>
                {count} {status.replace("_", " ")}
              </Badge>
            );
          })}
          <span className="text-xs text-muted-foreground self-center">{logs.length} total entries</span>
        </div>
      )}

      <Card className="bg-card border-border/50 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">Time</TableHead>
              <TableHead>Wallet</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                </TableRow>
              ))
            ) : logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground text-sm">
                  No activity yet. Run the agent or execute a sweep to see logs here.
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log: {
                id: number;
                createdAt: string;
                walletLabel?: string | null;
                action: string;
                status: string;
                message: string;
                txHash?: string | null;
                amount?: string | null;
              }) => {
                const cfg = STATUS_VARIANTS[log.status] ?? STATUS_VARIANTS.pending;
                return (
                  <TableRow key={log.id} className="border-border/40">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </TableCell>
                    <TableCell className="text-sm font-medium max-w-[140px] truncate" title={log.walletLabel ?? "-"}>
                      {log.walletLabel ?? <span className="text-muted-foreground italic">—</span>}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs bg-background border border-border/40 rounded px-1.5 py-0.5">
                        {ACTION_LABELS[log.action] ?? log.action}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={cfg.variant} className={`text-[10px] ${cfg.className}`}>
                        {log.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm max-w-[340px]">
                      <div className="truncate text-foreground/80" title={log.message}>{log.message}</div>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        {log.txHash && (
                          <a
                            href={`${RPC_EXPLORER}${log.txHash.toUpperCase()}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] font-mono text-primary hover:underline flex items-center gap-0.5"
                          >
                            TX: {log.txHash.slice(0, 16)}… <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        )}
                        {log.amount && (
                          <span className="text-[10px] text-emerald-400 font-mono font-semibold">{log.amount} MEC</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
