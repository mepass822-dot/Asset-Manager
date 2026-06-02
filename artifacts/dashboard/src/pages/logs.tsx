import { useState } from "react";
import { useListAgentLogs, useListWallets } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function Logs() {
  const [walletId, setWalletId] = useState<string>("all");
  
  const { data: wallets } = useListWallets(undefined, { query: { refetchInterval: 30_000 } });
  const { data: logs, isLoading, dataUpdatedAt } = useListAgentLogs(
    walletId !== "all" ? { walletId: parseInt(walletId) } : undefined,
    { query: { refetchInterval: 10_000 } }
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Activity Logs</h1>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
              Live
            </div>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Comprehensive audit trail of all agent operations.
          </p>
        </div>
        <div className="w-full md:w-[250px]">
          <Select value={walletId} onValueChange={setWalletId}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by Wallet" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Wallets</SelectItem>
              {wallets?.map(w => (
                <SelectItem key={w.id} value={w.id.toString()}>{w.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="bg-card border-border/50">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Wallet</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Message / Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                </TableRow>
              ))
            ) : !logs || logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">
                  No logs found.
                </TableCell>
              </TableRow>
            ) : (
              logs.map(log => (
                <TableRow key={log.id} className="border-border/50">
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-medium text-sm">
                    {log.walletLabel || '-'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {log.action}
                  </TableCell>
                  <TableCell>
                    <Badge variant={log.status === 'success' ? 'default' : log.status === 'error' ? 'destructive' : log.status === 'dry_run' ? 'secondary' : 'outline'}>
                      {log.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    <div>{log.message}</div>
                    {log.txHash && (
                      <div className="text-xs font-mono text-muted-foreground mt-1">TX: {log.txHash}</div>
                    )}
                    {log.amount && (
                      <div className="text-xs text-primary mt-1">Amt: {log.amount}</div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
