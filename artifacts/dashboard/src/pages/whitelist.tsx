import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListWhitelist,
  useCreateWhitelistEntry,
  useDeleteWhitelistEntry,
  getListWhitelistQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Trash2, ShieldCheck, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Whitelist() {
  const { data: entries, isLoading } = useListWhitelist();
  const createEntry = useCreateWhitelistEntry();
  const deleteEntry = useDeleteWhitelistEntry();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");

  const handleCreate = () => {
    if (!address.trim() || !label.trim()) {
      toast({ title: "Missing fields", description: "Both address and label are required.", variant: "destructive" });
      return;
    }
    if (!address.startsWith("me1") && !address.startsWith("gc1")) {
      toast({ title: "Invalid address", description: "Address must start with me1... or gc1...", variant: "destructive" });
      return;
    }

    createEntry.mutate(
      { data: { address: address.trim(), label: label.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListWhitelistQueryKey() });
          setIsAddOpen(false);
          setAddress("");
          setLabel("");
          toast({ title: "Address Whitelisted", description: "The destination address has been added to the security whitelist." });
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : "Failed to add address";
          toast({ title: "Error", description: msg, variant: "destructive" });
        },
      }
    );
  };

  const handleDelete = (id: number, addr: string) => {
    deleteEntry.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListWhitelistQueryKey() });
          toast({ title: "Address Removed", description: `${addr} has been removed from the whitelist.` });
        },
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Destination Whitelist</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Only these addresses can receive funds — from the AI agent or manual sends.
          </p>
        </div>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Address
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Whitelisted Address</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Label</Label>
                <Input
                  placeholder="e.g. Master Withdrawal Wallet"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Address</Label>
                <Input
                  placeholder="me1... or gc1..."
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={createEntry.isPending}>
                {createEntry.isPending ? "Adding..." : "Add to Whitelist"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {!isLoading && entries?.length === 0 && (
        <Alert className="border-yellow-500/50 bg-yellow-500/10">
          <ShieldAlert className="h-4 w-4 text-yellow-500" />
          <AlertDescription className="text-yellow-200">
            <strong>No whitelist configured.</strong> The agent can currently send to any address. Add at least one destination address to enable the security guardrail.
          </AlertDescription>
        </Alert>
      )}

      {!isLoading && entries && entries.length > 0 && (
        <Alert className="border-green-500/50 bg-green-500/10">
          <ShieldCheck className="h-4 w-4 text-green-500" />
          <AlertDescription className="text-green-200">
            Whitelist active — the AI agent and manual sends are restricted to {entries.length} approved destination{entries.length !== 1 ? "s" : ""}.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Approved Destinations
          </CardTitle>
          <CardDescription>
            Transactions targeting addresses not in this list will be blocked automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : entries && entries.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <Badge variant="secondary">{entry.label}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {entry.address}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDelete(entry.id, entry.address)}
                        disabled={deleteEntry.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <ShieldAlert className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No addresses whitelisted yet.</p>
              <p className="text-xs mt-1">Add a destination address above to start enforcing security restrictions.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
