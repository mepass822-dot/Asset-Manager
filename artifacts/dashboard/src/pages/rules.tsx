import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListRules, useCreateRule, useUpdateRule, useDeleteRule, getListRulesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, ListTree, Zap, TrendingUp, Coins, ArrowRightLeft, Bell, Layers } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface RulePreset {
  name: string;
  ruleType: string;
  description: string;
  icon: React.ReactNode;
  conditionJson: string;
  actionJson: string;
}

const PRESETS: RulePreset[] = [
  {
    name: "Auto-Sweep balances > 1 MEC",
    ruleType: "auto_withdraw",
    description: "Sweeps any wallet with balance above 1 MEC to master address",
    icon: <Zap className="h-4 w-4 text-primary" />,
    conditionJson: JSON.stringify({ balance_gt_mec: 1, applies_to: "all_verified" }, null, 2),
    actionJson: JSON.stringify({ action: "sweep_to_master", memo: "auto-sweep" }, null, 2),
  },
  {
    name: "High Balance Alert > 100 MEC",
    ruleType: "balance_alert",
    description: "Logs a high-balance alert when any wallet exceeds 100 MEC",
    icon: <Bell className="h-4 w-4 text-yellow-400" />,
    conditionJson: JSON.stringify({ balance_gt_mec: 100 }, null, 2),
    actionJson: JSON.stringify({ action: "log_alert", message: "High balance detected — consider sweeping" }, null, 2),
  },
  {
    name: "Claim staking rewards > 0.01 MEC",
    ruleType: "auto_withdraw",
    description: "Claims block rewards when they accumulate above 0.01 MEC",
    icon: <Coins className="h-4 w-4 text-emerald-400" />,
    conditionJson: JSON.stringify({ staking_rewards_gt_mec: 0.01 }, null, 2),
    actionJson: JSON.stringify({ action: "claim_staking_rewards", then_sweep: true }, null, 2),
  },
  {
    name: "Consolidate small balances > 0.1 MEC",
    ruleType: "consolidate",
    description: "Consolidates wallets with small balances above 0.1 MEC to master",
    icon: <Layers className="h-4 w-4 text-blue-400" />,
    conditionJson: JSON.stringify({ balance_gt_mec: 0.1, balance_lt_mec: 10 }, null, 2),
    actionJson: JSON.stringify({ action: "consolidate_to_master" }, null, 2),
  },
  {
    name: "Dividend window sweep (days 1–7)",
    ruleType: "auto_withdraw",
    description: "Sweeps all verified wallets during the dividend window",
    icon: <TrendingUp className="h-4 w-4 text-primary" />,
    conditionJson: JSON.stringify({ day_of_month_lte: 7, balance_gt_mec: 0.001 }, null, 2),
    actionJson: JSON.stringify({ action: "sweep_to_master", memo: "dividend-window-sweep", priority: "high" }, null, 2),
  },
  {
    name: "Emergency consolidate all > 0",
    ruleType: "consolidate",
    description: "Sweeps every wallet with any balance to master — use with caution",
    icon: <ArrowRightLeft className="h-4 w-4 text-destructive" />,
    conditionJson: JSON.stringify({ balance_gt_mec: 0.001 }, null, 2),
    actionJson: JSON.stringify({ action: "sweep_to_master", memo: "emergency-consolidation" }, null, 2),
  },
];

const TYPE_COLORS: Record<string, string> = {
  auto_withdraw: "bg-primary/15 text-primary border-primary/30",
  balance_alert: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  consolidate: "bg-blue-500/15 text-blue-400 border-blue-500/30",
};

export default function Rules() {
  const { data: rawRules, isLoading } = useListRules();
  const rules = Array.isArray(rawRules) ? rawRules : [];
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const deleteRule = useDeleteRule();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [ruleType, setRuleType] = useState("auto_withdraw");
  const [conditionJson, setConditionJson] = useState('{\n  "balance_gt_mec": 1\n}');
  const [actionJson, setActionJson] = useState('{\n  "action": "sweep_to_master"\n}');
  const [conditionError, setConditionError] = useState("");
  const [actionError, setActionError] = useState("");

  const applyPreset = (preset: RulePreset) => {
    setName(preset.name);
    setRuleType(preset.ruleType);
    setConditionJson(preset.conditionJson);
    setActionJson(preset.actionJson);
    setConditionError("");
    setActionError("");
    setIsAddOpen(true);
  };

  const validateJson = (str: string, field: "condition" | "action"): boolean => {
    try {
      JSON.parse(str);
      if (field === "condition") setConditionError("");
      else setActionError("");
      return true;
    } catch {
      const msg = "Invalid JSON — check syntax";
      if (field === "condition") setConditionError(msg);
      else setActionError(msg);
      return false;
    }
  };

  const handleCreate = () => {
    const condOk = validateJson(conditionJson, "condition");
    const actOk = validateJson(actionJson, "action");
    if (!condOk || !actOk) return;

    createRule.mutate(
      { data: { name, ruleType, enabled: true, conditionJson, actionJson } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() });
          setIsAddOpen(false);
          setName(""); setConditionJson('{\n  "balance_gt_mec": 1\n}'); setActionJson('{\n  "action": "sweep_to_master"\n}');
          toast({ title: "Rule Created", description: `"${name}" is now active.` });
        },
        onError: (err) => toast({ title: "Error", description: err instanceof Error ? err.message : "Failed to create rule", variant: "destructive" }),
      }
    );
  };

  const handleToggle = (id: number, enabled: boolean) => {
    updateRule.mutate({ id, data: { enabled } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() }),
    });
  };

  const handleDelete = (id: number, ruleName: string) => {
    deleteRule.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() });
        toast({ title: "Rule Deleted", description: `"${ruleName}" removed.` });
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Automation Rules</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Rules guide the AI agent — pick a preset or define custom JSON conditions and actions.
          </p>
        </div>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" /> Custom Rule
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle>Create Automation Rule</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label>Rule Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sweep balances > 100 MEC" />
              </div>
              <div className="grid gap-2">
                <Label>Rule Type</Label>
                <Select value={ruleType} onValueChange={setRuleType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto_withdraw">auto_withdraw — trigger a transfer/sweep</SelectItem>
                    <SelectItem value="balance_alert">balance_alert — log alert only, no transfer</SelectItem>
                    <SelectItem value="consolidate">consolidate — merge small balances</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label className="flex items-center justify-between">
                  Condition (JSON)
                  {conditionError && <span className="text-destructive text-xs font-normal">{conditionError}</span>}
                </Label>
                <textarea
                  className={`w-full h-28 bg-background border rounded-md px-3 py-2 text-xs font-mono resize-none outline-none focus:ring-1 transition-all ${conditionError ? "border-destructive focus:ring-destructive" : "border-border focus:border-primary focus:ring-primary/30"}`}
                  value={conditionJson}
                  onChange={e => { setConditionJson(e.target.value); validateJson(e.target.value, "condition"); }}
                  spellCheck={false}
                />
              </div>
              <div className="grid gap-2">
                <Label className="flex items-center justify-between">
                  Action (JSON)
                  {actionError && <span className="text-destructive text-xs font-normal">{actionError}</span>}
                </Label>
                <textarea
                  className={`w-full h-28 bg-background border rounded-md px-3 py-2 text-xs font-mono resize-none outline-none focus:ring-1 transition-all ${actionError ? "border-destructive focus:ring-destructive" : "border-border focus:border-primary focus:ring-primary/30"}`}
                  value={actionJson}
                  onChange={e => { setActionJson(e.target.value); validateJson(e.target.value, "action"); }}
                  spellCheck={false}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
              <Button disabled={createRule.isPending || !name} onClick={handleCreate}>
                {createRule.isPending ? "Creating…" : "Create Rule"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Preset templates */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wider">Quick Presets</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {PRESETS.map((preset) => (
            <Card
              key={preset.name}
              className="bg-card border-border/50 hover:border-primary/40 transition-colors cursor-pointer group"
              onClick={() => applyPreset(preset)}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 mt-0.5">{preset.icon}</div>
                  <div className="min-w-0">
                    <div className="font-medium text-sm leading-snug">{preset.name}</div>
                    <div className="text-xs text-muted-foreground mt-1 leading-relaxed">{preset.description}</div>
                    <Badge variant="outline" className={`mt-2 text-[10px] ${TYPE_COLORS[preset.ruleType] ?? ""}`}>
                      {preset.ruleType}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Active rules table */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wider">
          Active Rules {rules.length > 0 && <span className="text-primary">({rules.length})</span>}
        </h2>
        <Card className="bg-card border-border/50">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-14">On</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="text-right w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}><Skeleton className="h-8 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : rules.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">
                    <ListTree className="h-6 w-6 mx-auto mb-2 opacity-30" />
                    No rules yet — pick a preset above or create a custom rule.
                  </TableCell>
                </TableRow>
              ) : (
                rules.map((rule) => (
                  <TableRow key={rule.id} className={rule.enabled ? "" : "opacity-50"}>
                    <TableCell>
                      <Switch checked={rule.enabled} onCheckedChange={(v) => handleToggle(rule.id, v)} />
                    </TableCell>
                    <TableCell className="font-medium flex items-center gap-2">
                      <ListTree className="h-4 w-4 text-primary shrink-0" />
                      {rule.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-xs ${TYPE_COLORS[rule.ruleType] ?? "border-border/50 text-muted-foreground"}`}>
                        {rule.ruleType}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-w-[180px] truncate" title={rule.conditionJson ?? undefined}>
                      {rule.conditionJson}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-w-[180px] truncate" title={rule.actionJson ?? undefined}>
                      {rule.actionJson}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(rule.id, rule.name)}
                        className="text-destructive hover:bg-destructive/10 h-8 w-8"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
