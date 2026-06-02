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
import { Plus, Trash2, Wallet as WalletIcon, Network, Download, Puzzle, ChevronRight, Copy, Check, Hash, Layers, KeyRound, BookText } from "lucide-react";
import { SendDialog } from "@/components/send-dialog";
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
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="text-muted-foreground hover:text-primary transition-colors ml-1"
    >
      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// ─── Derive-preview dialog ────────────────────────────────────────────────────
interface DerivedAccount { address: string; hdIndex: number; hdPath: string; }

function DeriveAccountsDialog({ onImport }: { onImport: (accounts: DerivedAccount[], mnemonic: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mnemonic, setMnemonic] = useState("");
  const [count, setCount] = useState(5);
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<DerivedAccount[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState("mainnet");
  const [step, setStep] = useState<"input" | "select">("input");
  const { toast } = useToast();

  const derive = async () => {
    if (!mnemonic.trim()) return;
    setLoading(true);
    try {
      const resp = await fetch("/api/wallets/derive-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mnemonic: mnemonic.trim(), count }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      setAccounts(data.accounts);
      setSelected(new Set(data.accounts.map((a: DerivedAccount) => a.hdIndex)));
      setStep("select");
    } catch (e) {
      toast({ title: "Derivation failed", description: String(e), variant: "destructive" });
    }
    setLoading(false);
  };

  const handleImport = () => {
    const chosen = accounts.filter(a => selected.has(a.hdIndex));
    onImport(chosen, mnemonic.trim());
    setOpen(false);
    setMnemonic(""); setAccounts([]); setSelected(new Set()); setStep("input"); setPassword("");
  };

  const toggleSelect = (idx: number) => {
    const s = new Set(selected);
    s.has(idx) ? s.delete(idx) : s.add(idx);
    setSelected(s);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setStep("input"); setAccounts([]); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 border-border/60">
          <Layers className="h-4 w-4" /> Derive Multiple Accounts
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Derive Multiple Accounts</DialogTitle>
          <DialogDescription>
            Generate up to 20 wallet addresses from one mnemonic using different HD path indices — the same way the Meta Earth extension creates multiple accounts.
          </DialogDescription>
        </DialogHeader>

        {step === "input" && (
          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label>Mnemonic Phrase</Label>
              <textarea
                className="w-full h-20 bg-background border border-border rounded-md px-3 py-2 text-sm font-mono resize-none outline-none focus:border-primary placeholder:text-muted-foreground"
                placeholder="word1 word2 word3 ... (12 or 24 words)"
                value={mnemonic}
                onChange={e => setMnemonic(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Number of accounts to derive</Label>
              <Select value={String(count)} onValueChange={v => setCount(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1,2,3,5,10,15,20].map(n => (
                    <SelectItem key={n} value={String(n)}>{n} account{n > 1 ? "s" : ""} (index 0–{n-1})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button disabled={!mnemonic.trim() || loading} onClick={derive}>
                {loading ? "Deriving..." : "Derive Addresses"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "select" && (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">Select which accounts to add to the agent. All share the same mnemonic.</p>
            <div className="rounded-lg border border-border/50 overflow-hidden max-h-64 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-border/50">
                    <TableHead className="w-8"></TableHead>
                    <TableHead className="text-xs">Index</TableHead>
                    <TableHead className="text-xs">Address</TableHead>
                    <TableHead className="text-xs">HD Path</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map(a => (
                    <TableRow
                      key={a.hdIndex}
                      className={`border-border/50 cursor-pointer transition-colors ${selected.has(a.hdIndex) ? "bg-primary/5" : ""}`}
                      onClick={() => toggleSelect(a.hdIndex)}
                    >
                      <TableCell>
                        <div className={`w-4 h-4 rounded border ${selected.has(a.hdIndex) ? "bg-primary border-primary" : "border-border"} flex items-center justify-center`}>
                          {selected.has(a.hdIndex) && <Check className="h-2.5 w-2.5 text-black" />}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-primary">{a.hdIndex}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {a.address.slice(0, 12)}...{a.address.slice(-6)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{a.hdPath}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="grid gap-2">
              <Label>Encryption password for agent</Label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Used to encrypt the mnemonic securely" />
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
              <Button variant="ghost" onClick={() => setStep("input")}>Back</Button>
              <Button disabled={selected.size === 0 || !password} onClick={handleImport}>
                Add {selected.size} Account{selected.size !== 1 ? "s" : ""}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Extension import dialog ──────────────────────────────────────────────────
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

      // Expand all accounts within each wallet entry
      const wallets: any[] = [];
      accountList.forEach((w: any, wi: number) => {
        if (!w.mnemonic) return;
        const accounts: any[] = Array.isArray(w.accounts) ? w.accounts : [];
        if (accounts.length === 0) {
          wallets.push({ label: w.walletName || `Wallet ${wi + 1}`, mnemonic: w.mnemonic, hdIndex: 0, password, network });
        } else {
          accounts.forEach((a: any, ai: number) => {
            wallets.push({
              label: a.accountName || w.walletName ? `${w.walletName || `Wallet ${wi+1}`} / Account ${ai}` : `Account ${ai}`,
              mnemonic: w.mnemonic,
              address: a.address || "",
              hdIndex: typeof w.accountOffset === "number" ? w.accountOffset + ai : ai,
              password,
              network,
            });
          });
        }
      });

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
      toast({ title: "Import complete", description: `${result.imported} account(s) imported, ${result.skipped} skipped.` });
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
          <DialogDescription>Import all your accounts — including multiple accounts per wallet — from the Meta Earth extension.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 mb-2">
          {[1, 2, 3].map(s => (
            <div key={s} className={`flex-1 h-1 rounded-full transition-colors ${step >= s ? "bg-primary" : "bg-border"}`} />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-border/60 bg-card p-4 space-y-3">
              {[
                { n: 1, title: "Download MEC Bridge extension", body: <>A helper that reads all your wallet accounts from the Meta Earth extension.<br/><a href="/api/wallets/bridge-extension.zip" download className="inline-flex items-center gap-1 mt-1.5 text-xs text-primary hover:underline"><Download className="h-3 w-3" /> Download bridge-extension.zip</a></> },
                { n: 2, title: "Load it in Chrome", body: <>Open <code className="bg-muted px-1 rounded">chrome://extensions</code> → Enable Developer mode → Load unpacked → select extracted folder.</> },
                { n: 3, title: "Click the bridge icon", body: <>Enter your dashboard URL and a password, then click Export. All your wallet accounts will be imported automatically.<div className="flex items-center gap-1 mt-1 bg-muted rounded px-2 py-1 font-mono text-xs text-primary w-fit">{dashboardUrl}<CopyButton text={dashboardUrl} /></div></> },
              ].map(({ n, title, body }) => (
                <div key={n} className="flex items-start gap-3">
                  <div className="rounded-full bg-primary/10 text-primary w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">{n}</div>
                  <div><p className="text-sm font-medium">{title}</p><p className="text-xs text-muted-foreground mt-1">{body}</p></div>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => setStep(2)} className="gap-1">Manual Import <ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>How to get your wallet data</Label>
              <div className="rounded-lg border border-border/60 bg-card p-3 text-xs text-muted-foreground space-y-1.5">
                <p>1. Open Chrome DevTools (F12) while the Meta Earth extension popup is open</p>
                <p>2. Switch to the <strong className="text-foreground">Application</strong> tab → Local Storage → extension origin</p>
                <p>3. Find the key <code className="bg-muted px-1 rounded text-primary">accountList</code> and copy its value</p>
                <p>4. Or in Console run: <code className="bg-muted px-1 rounded text-primary">copy(localStorage.accountList)</code></p>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={() => setStep(3)} className="gap-1">Continue <ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label>Paste accountList JSON from extension</Label>
              <textarea
                className="w-full h-28 bg-background border border-border rounded-md px-3 py-2 text-xs font-mono resize-none outline-none focus:border-primary placeholder:text-muted-foreground"
                placeholder='[{"mnemonic":"word1 word2...","accounts":[{"address":"me1..."},{"address":"me1..."}],...}]'
                value={jsonText}
                onChange={e => setJsonText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">All accounts inside each wallet will be imported as separate agent-managed entries.</p>
            </div>
            <div className="grid gap-2">
              <Label>Encryption password for agent</Label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password to encrypt mnemonics in the agent" />
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
                {loading ? "Importing..." : "Import All Accounts"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Wallets() {
  const { data: wallets, isLoading } = useListWallets(undefined, { query: { refetchInterval: 30_000 } });
  const createWallet = useCreateWallet();
  const deleteWallet = useDeleteWallet();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [addMode, setAddMode] = useState<"mnemonic" | "privateKey">("mnemonic");
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState("mainnet");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListWalletsQueryKey() });

  const handleCreate = () => {
    const data: any = { label, password, network };
    if (addMode === "privateKey") {
      data.privateKey = privateKey;
    } else {
      data.mnemonic = mnemonic;
    }
    createWallet.mutate(
      { data },
      {
        onSuccess: () => {
          invalidate();
          setIsAddOpen(false);
          setLabel(""); setMnemonic(""); setPrivateKey(""); setPassword(""); setNetwork("mainnet");
          toast({ title: "Wallet Added", description: addMode === "privateKey" ? "Wallet imported from private key." : "Account 0 (index 0) added successfully." });
        },
        onError: (err: any) => {
          toast({ title: "Error", description: err?.message || "Failed to add wallet.", variant: "destructive" });
        }
      }
    );
  };

  // Called by DeriveAccountsDialog after user selects accounts
  const handleDerivedImport = async (accounts: { address: string; hdIndex: number; hdPath: string }[], mnemonicPhrase: string) => {
    // Show a password dialog — for simplicity we prompt inline
    const pwd = window.prompt("Enter encryption password for these accounts:");
    if (!pwd) return;
    const net = "mainnet";

    const wallets = accounts.map(a => ({
      label: `Account ${a.hdIndex}`,
      mnemonic: mnemonicPhrase,
      address: a.address,
      hdIndex: a.hdIndex,
      password: pwd,
      network: net,
    }));

    const resp = await fetch("/api/wallets/import-extension", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets }),
    });
    const result = await resp.json();
    toast({ title: "Accounts added", description: `${result.imported} imported, ${result.skipped} already existed.` });
    invalidate();
  };

  const handleDelete = (id: number) => {
    deleteWallet.mutate({ id }, {
      onSuccess: () => { invalidate(); toast({ title: "Wallet Deleted" }); }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Wallets</h1>
          <p className="text-muted-foreground mt-1 text-sm">Manage your Meta Earth Coin wallets and derived accounts.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <ExtensionImportDialog onImported={invalidate} />
          <DeriveAccountsDialog onImport={handleDerivedImport} />
          <Dialog open={isAddOpen} onOpenChange={(v) => { setIsAddOpen(v); if (!v) { setLabel(""); setMnemonic(""); setPrivateKey(""); setPassword(""); setNetwork("mainnet"); setAddMode("mnemonic"); } }}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="h-4 w-4" /> Add Manually</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[440px]">
              <DialogHeader>
                <DialogTitle>Add Wallet Manually</DialogTitle>
                <DialogDescription>Import using a mnemonic phrase or a raw private key.</DialogDescription>
              </DialogHeader>

              {/* Mode switcher */}
              <div className="flex rounded-lg border border-border/60 overflow-hidden text-sm">
                <button
                  onClick={() => setAddMode("mnemonic")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 transition-colors ${addMode === "mnemonic" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                >
                  <BookText className="h-3.5 w-3.5" /> Mnemonic Phrase
                </button>
                <button
                  onClick={() => setAddMode("privateKey")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 transition-colors border-l border-border/60 ${addMode === "privateKey" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                >
                  <KeyRound className="h-3.5 w-3.5" /> Private Key
                </button>
              </div>

              <div className="grid gap-4 py-2">
                <div className="grid gap-2">
                  <Label htmlFor="label">Label</Label>
                  <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My MEC Account" />
                </div>

                {addMode === "mnemonic" ? (
                  <div className="grid gap-2">
                    <Label htmlFor="mnemonic">Mnemonic Phrase</Label>
                    <textarea
                      id="mnemonic"
                      className="w-full h-20 bg-background border border-border rounded-md px-3 py-2 text-sm font-mono resize-none outline-none focus:border-primary placeholder:text-muted-foreground"
                      placeholder="word1 word2 word3 ... (12 or 24 words)"
                      value={mnemonic}
                      onChange={(e) => setMnemonic(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Derives account index 0. Use "Derive Multiple Accounts" for more.</p>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="privateKey">Private Key</Label>
                    <Input
                      id="privateKey"
                      type="password"
                      className="font-mono"
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      placeholder="Hex (64 chars), 0x-prefixed hex, or Base64"
                    />
                    <p className="text-xs text-muted-foreground">Accepts raw secp256k1 private key in hex (with or without 0x) or Base64 format.</p>
                  </div>
                )}

                <div className="grid gap-2">
                  <Label htmlFor="password">Encryption Password</Label>
                  <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Used to encrypt the key securely" />
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
              </div>
              <DialogFooter>
                <Button
                  disabled={createWallet.isPending || !label || (addMode === "mnemonic" ? !mnemonic : !privateKey) || !password}
                  onClick={handleCreate}
                >
                  {createWallet.isPending ? "Importing..." : addMode === "privateKey" ? "Import from Private Key" : "Add Wallet"}
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
              <TableHead className="text-center">HD Index</TableHead>
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
                  <TableCell><Skeleton className="h-4 w-8 mx-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-8 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : wallets?.length === 0 ? (
              <TableRow className="border-border hover:bg-transparent">
                <TableCell colSpan={6} className="h-36 text-center">
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <WalletIcon className="h-8 w-8 opacity-30" />
                    <div>
                      <p className="text-sm">No wallets yet.</p>
                      <p className="text-xs mt-1">Use <strong className="text-primary">Import from Extension</strong> to pull in all your Meta Earth accounts, or <strong className="text-foreground">Derive Multiple Accounts</strong> from a single mnemonic.</p>
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
                  <TableCell className="text-center">
                    <span className="font-mono text-xs text-primary bg-primary/10 rounded px-1.5 py-0.5">
                      #{(wallet as any).hdIndex ?? 0}
                    </span>
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
                    <div className="flex items-center justify-end gap-0.5">
                      <SendDialog wallet={wallet} />
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(wallet.id)} className="text-destructive hover:bg-destructive/10 hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
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
