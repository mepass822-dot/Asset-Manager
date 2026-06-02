import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListWallets, useCreateWallet, useDeleteWallet, useGetWalletBalance, getListWalletsQueryKey } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2, Wallet as WalletIcon, Network, Download, Puzzle, ChevronRight, Copy, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={copy} className="text-muted-foreground hover:text-primary transition-colors ml-1">
      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function ExtensionImportDialog({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState("mainnet");
  const [jsonText, setJsonText] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const dashboardUrl = window.location.origin;

  const reset = () => { setStep(1); setPassword(""); setJsonText(""); setNetwork("mainnet"); };

  const handleJsonImport = async () => {
    if (!jsonText || !password) return;
    setLoading(true);
    try {
      let accountList: any[];
      try { accountList = JSON.parse(jsonText); } catch {
        toast({ title: "Invalid JSON", description: "Could not parse the pasted data.", variant: "destructive" });
        setLoading(false);
        return;
      }
      if (!Array.isArray(accountList)) accountList = [accountList];

      const wallets = accountList
        .filter((w: any) => w.mnemonic && w.accounts?.some((a: any) => a.address))
        .map((w: any, i: number) => ({
          label: w.walletName || w.accounts?.[0]?.accountName || `Imported Wallet ${i + 1}`,
          mnemonic: w.mnemonic,
          address: w.accounts?.[0]?.address || "",
          password,
          network
        }));

      if (wallets.length === 0) {
        toast({ title: "No valid wallets", description: "The pasted data had no wallets with mnemonics.", variant: "destructive" });
        setLoading(false);
        return;
      }

      const resp = await fetch("/api/wallets/import-extension", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallets })
      });
      const result = await resp.json();
      toast({ title: "Import complete", description: `${result.imported} wallet(s) imported, ${result.skipped} skipped.` });
      onImported();
      setOpen(false);
      reset();
    } catch (err) {
      toast({ title: "Import failed", description: String(err), variant: "destructive" });
    }
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 border-primary/40 text-primary hover:bg-primary/10">
          <Puzzle className="h-4 w-4" /> Import from Extension
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Import from Meta Earth Extension</DialogTitle>
          <DialogDescription>
            Connect directly to your existing Meta Earth Chrome extension wallets.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 mb-2">
          {[1, 2, 3].map(s => (
            <div key={s} className={`flex-1 h-1 rounded-full transition-colors ${step >= s ? "bg-primary" : "bg-border"}`} />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-border/60 bg-card p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-primary/10 text-primary w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">1</div>
                <div>
                  <p className="text-sm font-medium">Download the MEC Agent Bridge extension</p>
                  <p className="text-xs text-muted-foreground mt-1">A small helper extension that reads your wallets from Meta Earth and exports them securely.</p>
                  <a href="/api/wallets/bridge-extension.zip" download className="inline-flex items-center gap-1.5 mt-2 text-xs text-primary hover:underline">
                    <Download className="h-3 w-3" /> Download bridge-extension.zip
                  </a>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-primary/10 text-primary w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">2</div>
                <div>
                  <p className="text-sm font-medium">Load it in Chrome</p>
                  <p className="text-xs text-muted-foreground mt-1">Open <code className="bg-muted px-1 rounded">chrome://extensions</code> → Enable "Developer mode" → Click "Load unpacked" → Select the extracted folder.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-primary/10 text-primary w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">3</div>
                <div>
                  <p className="text-sm font-medium">Click the bridge extension icon</p>
                  <p className="text-xs text-muted-foreground mt-1">Enter this dashboard URL and your desired encryption password, then click Export.</p>
                  <div className="flex items-center gap-1 mt-1 bg-muted rounded px-2 py-1 font-mono text-xs text-primary w-fit">
                    {dashboardUrl}
                    <CopyButton text={dashboardUrl} />
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded p-3">
              <span>Or skip the extension and paste your wallet data manually in the next step.</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => setStep(2)} className="gap-1">
                Manual Import <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>How to get your wallet data (manual method)</Label>
              <div className="rounded-lg border border-border/60 bg-card p-3 text-xs text-muted-foreground space-y-1.5">
                <p>1. Open the Meta Earth extension → click your wallet name</p>
                <p>2. Go to <strong className="text-foreground">Settings</strong> → <strong className="text-foreground">Backup Wallet</strong></p>
                <p>3. Open Chrome DevTools on the extension page (F12)</p>
                <p>4. In the Console, run: <code className="bg-muted px-1 rounded text-primary">JSON.stringify(JSON.parse(localStorage.getItem('accountList')))</code></p>
                <p>5. Copy the output and paste it below</p>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={() => setStep(3)} className="gap-1">
                Continue <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label>Paste wallet data (JSON from extension)</Label>
              <textarea
                className="w-full h-28 bg-background border border-border rounded-md px-3 py-2 text-xs font-mono resize-none outline-none focus:border-primary placeholder:text-muted-foreground"
                placeholder='[{"mnemonic":"word1 word2...","accounts":[{"address":"me1..."}],...}]'
                value={jsonText}
                onChange={e => setJsonText(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Encryption password for agent</Label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Set a password to encrypt mnemonics in the agent" />
            </div>
            <div className="grid gap-2">
              <Label>Network</Label>
              <Select value={network} onValueChange={setNetwork}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mainnet">Mainnet</SelectItem>
                  <SelectItem value="testnet">Testnet</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
              <Button disabled={!jsonText || !password || loading} onClick={handleJsonImport}>
                {loading ? "Importing..." : "Import Wallets"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListWalletsQueryKey() });

  const handleCreate = () => {
    createWallet.mutate(
      { data: { label, mnemonic, password, network } },
      {
        onSuccess: () => {
          invalidate();
          setIsAddOpen(false);
          setLabel(""); setMnemonic(""); setPassword(""); setNetwork("mainnet");
          toast({ title: "Wallet Added", description: "The wallet was added successfully." });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to add wallet.", variant: "destructive" });
        }
      }
    );
  };

  const handleDelete = (id: number) => {
    deleteWallet.mutate({ id }, {
      onSuccess: () => {
        invalidate();
        toast({ title: "Wallet Deleted", description: "The wallet was removed." });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Wallets</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your Meta Earth Coin wallets.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <ExtensionImportDialog onImported={invalidate} />
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="h-4 w-4" /> Add Manually</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>Add Wallet Manually</DialogTitle>
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
                    <SelectTrigger><SelectValue placeholder="Select network" /></SelectTrigger>
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
                <TableCell colSpan={5} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <WalletIcon className="h-8 w-8 opacity-30" />
                    <div>
                      <p className="text-sm">No wallets yet.</p>
                      <p className="text-xs mt-1">Click <strong className="text-primary">Import from Extension</strong> to pull in your Meta Earth wallets.</p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              wallets?.map((wallet) => (
                <TableRow key={wallet.id} className="border-border">
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <WalletIcon className="h-4 w-4 text-primary shrink-0" />
                      {wallet.label}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <div className="flex items-center">
                      {wallet.address.slice(0, 10)}...{wallet.address.slice(-8)}
                      <CopyButton text={wallet.address} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs gap-1 border-border/50">
                      <Network className="h-3 w-3" /> {wallet.network}
                    </Badge>
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
