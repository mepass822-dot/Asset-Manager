import { useGetAgentStats, useListAgentLogs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, CheckCircle, XCircle, Wallet, Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetAgentStats();
  const { data: logs, isLoading: logsLoading } = useListAgentLogs({ limit: 5 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">System Overview</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Real-time metrics and recent automated activity.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Managed Wallets</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold text-primary">{stats?.totalWallets || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Rules</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold">{stats?.activeRules || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold text-primary">
                {stats?.totalWithdrawals ? Math.round((stats.successfulWithdrawals / stats.totalWithdrawals) * 100) : 100}%
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed Actions</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold text-destructive">{stats?.failedWithdrawals || 0}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-1">
        <Card className="bg-card border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              Recent Agent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {logsLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))
              ) : logs && logs.length > 0 ? (
                logs.map((log) => (
                  <div key={log.id} className="flex items-center justify-between p-3 border border-border rounded-md bg-background/50">
                    <div className="flex flex-col">
                      <span className="font-mono text-sm font-medium">{log.action}</span>
                      <span className="text-xs text-muted-foreground">{log.walletLabel || 'Unknown'} - {new Date(log.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{log.message}</span>
                      <Badge variant={log.status === 'success' ? 'default' : log.status === 'error' ? 'destructive' : 'secondary'}>
                        {log.status}
                      </Badge>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-6 text-muted-foreground text-sm">No recent activity</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
