import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListWallets, useCreateWallet, useDeleteWallet, useGetWalletBalance, getListWalletsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2, Key, Wallet as WalletIcon, Network, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function WalletBalanceDisplay({ id }: { id: number }) {
  const { data: balance, isLoading } = useGetWalletBalance(id);

  if (isLoading) return <Skeleton className="h-4 w-16" />;
  if (!balance) return <span className="text-muted-foreground">-</span>;

  return (
    <div className="flex flex-col">
      <span className="font-mono text-primary">{balance.balance} {balance.denom}</span>
      {balance.usdValue && <span className="text-xs text-muted-foreground">${balance.usdValue}</span>}
    </div>
  );
}

export default function Wallets() {
  const { data: wallets, isLoading } = useListWallets();
  const createWallet = useCreateWallet();
  const deleteWallet = useDeleteWallet();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState("mainnet");

  const handleCreate = () => {
    createWallet.mutate(
      { data: { label, mnemonic, password, network } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListWalletsQueryKey() });
          setIsAddOpen(false);
          setLabel("");
          setMnemonic("");
          setPassword("");
          setNetwork("mainnet");
          toast({ title: "Wallet Added", description: "The wallet was added successfully." });
        },
        onError: (err) => {
          toast({ title: "Error", description: "Failed to add wallet.", variant: "destructive" });
        }
      }
    );
  };

  const handleDelete = (id: number) => {
    deleteWallet.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListWalletsQueryKey() });
        toast({ title: "Wallet Deleted", description: "The wallet was removed successfully." });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Wallets</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your Meta Earth Coin wallets.
          </p>
        </div>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" /> Add Wallet
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Add New Wallet</DialogTitle>
              <DialogDescription>
                Import a wallet using its mnemonic phrase. It will be securely encrypted.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="label">Label</Label>
                <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main Ops" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mnemonic">Mnemonic Phrase</Label>
                <Input id="mnemonic" type="password" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} placeholder="word1 word2 ..." />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Encryption Password</Label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Required for agent execution" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="network">Network</Label>
                <Select value={network} onValueChange={setNetwork}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select network" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mainnet">Mainnet</SelectItem>
                    <SelectItem value="testnet">Testnet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button disabled={createWallet.isPending || !label || !mnemonic || !password} onClick={handleCreate}>
                {createWallet.isPending ? "Adding..." : "Add Wallet"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="bg-card border-border/50">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead>Label</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Network</TableHead>
              <TableHead>Live Balance</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i} className="border-border">
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-8 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : wallets?.length === 0 ? (
              <TableRow className="border-border hover:bg-transparent">
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No wallets added yet.
                </TableCell>
              </TableRow>
            ) : (
              wallets?.map((wallet) => (
                <TableRow key={wallet.id} className="border-border">
                  <TableCell className="font-medium flex items-center gap-2">
                    <WalletIcon className="h-4 w-4 text-primary" />
                    {wallet.label}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {wallet.address.slice(0, 8)}...{wallet.address.slice(-8)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 text-xs border border-border/50 bg-background rounded-full px-2 py-0.5 w-fit">
                      <Network className="h-3 w-3" /> {wallet.network}
                    </div>
                  </TableCell>
                  <TableCell>
                    <WalletBalanceDisplay id={wallet.id} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(wallet.id)} className="text-destructive hover:bg-destructive/10 hover:text-destructive">
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
