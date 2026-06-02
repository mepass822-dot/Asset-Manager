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
import { Plus, Trash2, ListTree, Code } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Rules() {
  const { data: rules, isLoading } = useListRules();
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const deleteRule = useDeleteRule();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [ruleType, setRuleType] = useState("auto_withdraw");
  const [conditionJson, setConditionJson] = useState('{"balance_gt": 100}');
  const [actionJson, setActionJson] = useState('{"withdraw_to": "master_address"}');

  const handleCreate = () => {
    try {
      JSON.parse(conditionJson);
      JSON.parse(actionJson);
    } catch (e) {
      toast({ title: "Invalid JSON", description: "Please enter valid JSON for condition and action.", variant: "destructive" });
      return;
    }

    createRule.mutate(
      { data: { name, ruleType, enabled: true, conditionJson, actionJson } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() });
          setIsAddOpen(false);
          setName("");
          toast({ title: "Rule Created", description: "Automation rule active." });
        }
      }
    );
  };

  const handleToggle = (id: number, enabled: boolean) => {
    updateRule.mutate(
      { id, data: { enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() });
        }
      }
    );
  };

  const handleDelete = (id: number) => {
    deleteRule.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() });
        }
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Automation Rules</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Configure conditions and actions for the agent to execute autonomously.
          </p>
        </div>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" /> New Rule
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Create Automation Rule</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Rule Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Sweep balances > 100 MEC" />
              </div>
              <div className="grid gap-2">
                <Label>Rule Type</Label>
                <Select value={ruleType} onValueChange={setRuleType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto_withdraw">Auto Withdraw</SelectItem>
                    <SelectItem value="balance_alert">Balance Alert</SelectItem>
                    <SelectItem value="consolidate">Consolidate</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label className="flex items-center gap-1"><Code className="h-3 w-3"/> Condition (JSON)</Label>
                <Input className="font-mono text-xs" value={conditionJson} onChange={e => setConditionJson(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label className="flex items-center gap-1"><Code className="h-3 w-3"/> Action (JSON)</Label>
                <Input className="font-mono text-xs" value={actionJson} onChange={e => setActionJson(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button disabled={createRule.isPending || !name} onClick={handleCreate}>
                Create Rule
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="bg-card border-border/50">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
            ) : rules?.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center h-24 text-muted-foreground">No rules configured.</TableCell></TableRow>
            ) : (
              rules?.map(rule => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Switch checked={rule.enabled} onCheckedChange={(v) => handleToggle(rule.id, v)} />
                  </TableCell>
                  <TableCell className="font-medium flex items-center gap-2">
                    <ListTree className="h-4 w-4 text-primary" />
                    {rule.name}
                  </TableCell>
                  <TableCell><div className="text-xs bg-secondary rounded px-2 py-1 w-fit">{rule.ruleType}</div></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground max-w-[200px] truncate">
                    {rule.conditionJson}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(rule.id)} className="text-destructive hover:bg-destructive/10">
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
  );
}
