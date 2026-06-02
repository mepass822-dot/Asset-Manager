import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListWallets, useRunAgent, getListAgentLogsQueryKey, getGetAgentStatsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Play, Bot, AlertTriangle, CheckCircle, Terminal } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { AgentRunResult, AgentLog } from "@workspace/api-client-react";

export default function Agent() {
  const { data: wallets, isLoading: walletsLoading } = useListWallets();
  const runAgent = useRunAgent();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [selectedWallets, setSelectedWallets] = useState<Set<number>>(new Set());
  const [masterPassword, setMasterPassword] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState<AgentRunResult | null>(null);

  const toggleWallet = (id: number) => {
    const newSet = new Set(selectedWallets);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedWallets(newSet);
  };

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
        onError: (err) => {
          toast({ title: "Agent Run Failed", description: "Check password or connection.", variant: "destructive" });
        }
      }
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Run Agent</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Execute automated operations across selected wallets.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1 space-y-6">
          <Card className="bg-card border-border/50">
            <CardHeader>
              <CardTitle className="text-lg">Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Label>Target Wallets</Label>
                <div className="space-y-2 max-h-[200px] overflow-auto border border-border/50 rounded-md p-2">
                  {walletsLoading ? (
                    <div className="text-sm text-muted-foreground">Loading wallets...</div>
                  ) : wallets?.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No wallets available.</div>
                  ) : (
                    wallets?.map(w => (
                      <div key={w.id} className="flex items-center space-x-2">
                        <Checkbox 
                          id={`wallet-${w.id}`} 
                          checked={selectedWallets.has(w.id)}
                          onCheckedChange={() => toggleWallet(w.id)}
                        />
                        <label htmlFor={`wallet-${w.id}`} className="text-sm font-medium leading-none cursor-pointer">
                          {w.label} <span className="text-muted-foreground font-mono text-xs">({w.address.slice(0, 6)}...)</span>
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
                  onChange={(e) => setMasterPassword(e.target.value)} 
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
                {result?.logs.map((log: AgentLog, i) => (
                  <div key={i} className="mb-3 flex flex-col gap-1 border-b border-border/20 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">[{new Date(log.createdAt).toLocaleTimeString()}]</span>
                      <span className="text-primary/80">[{log.walletLabel}]</span>
                      <Badge variant={log.status === 'success' ? 'default' : log.status === 'error' ? 'destructive' : 'secondary'} className="text-[10px] h-4 py-0">
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
