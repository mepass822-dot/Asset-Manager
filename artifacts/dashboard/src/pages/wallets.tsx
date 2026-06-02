import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListWallets, useCreateWallet, useDeleteWallet, useGetWalletBalance, useGetWalletTransactions, useGetWalletStakingRewards, useBulkImportWallets, getListWalletsQueryKey } from "@workspace/api-client-react";
import { authFetch } from "@/lib/firebase";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2, Wallet as WalletIcon, Network, Download, Puzzle, ChevronRight, ChevronDown, Copy, Check, Hash, Layers, KeyRound, BookText, ArrowUpRight, ArrowDownLeft, History, ExternalLink, RefreshCw, ShieldCheck, ShieldOff, Upload, Coins, Eye, EyeOff, CheckSquare, Square, X } from "lucide-react";
import { SendDialog } from "@/components/send-dialog";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

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

function DeriveAccountsDialog({ onImport }: { onImport: (accounts: DerivedAccount[], mnemonic: string, password: string) => void }) {
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
      const resp = await authFetch("/api/wallets/derive-accounts", {
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
    onImport(chosen, mnemonic.trim(), password);
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
          <DialogDescription>Derive HD wallet accounts from a single mnemonic phrase.</DialogDescription>
        </DialogHeader>

        {step === "input" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Mnemonic Phrase</Label>
              <textarea
                className="w-full h-20 bg-background border border-border rounded-md px-3 py-2 text-sm font-mono resize-none outline-none focus:border-primary placeholder:text-muted-foreground"
                placeholder="word1 word2 word3 ... (12 or 24 words)"
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Number of accounts to derive</Label>
              <Input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} />
            </div>
            <div className="space-y-2">
              <Label>Network</Label>
              <Select value={network} onValueChange={setNetwork}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mainnet">Mainnet</SelectItem>
                  <SelectItem value="testnet">Testnet</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full" onClick={derive} disabled={loading || !mnemonic.trim()}>
              {loading ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : null}
              {loading ? "Deriving..." : "Preview Accounts"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2 max-h-[240px] overflow-auto border border-border/50 rounded-md p-2">
              {accounts.map((a) => (
                <div key={a.hdIndex} className="flex items-center gap-2 p-1 hover:bg-muted/30 rounded">
                  <Checkbox id={`acc-${a.hdIndex}`} checked={selected.has(a.hdIndex)} onCheckedChange={() => toggleSelect(a.hdIndex)} />
                  <label htmlFor={`acc-${a.hdIndex}`} className="flex-1 cursor-pointer">
                    <span className="text-xs font-mono text-primary bg-primary/10 rounded px-1 mr-2">#{a.hdIndex}</span>
                    <span className="font-mono text-xs text-muted-foreground">{a.address.slice(0, 12)}…{a.address.slice(-8)}</span>
                  </label>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <Label>Encryption Password</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Encrypt all imported wallets with this password" />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep("input")} className="flex-1">Back</Button>
              <Button className="flex-1" onClick={handleImport} disabled={selected.size === 0 || !password}>
                Import {selected.size} Account{selected.size !== 1 ? "s" : ""}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Extension import dialog ──────────────────────────────────────────────────
function ExtensionImportDialog({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"extension" | "download">("extension");
  const [accounts, setAccounts] = useState<Array<{ address: string; name?: string }>>([]);
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState("mainnet");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleMessage = React.useCallback((e: MessageEvent) => {
    if (e.data?.type === "MEC_ACCOUNTS" && Array.isArray(e.data.accounts)) {
      setAccounts(e.data.accounts);
    }
  }, []);

  React.useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const requestAccounts = () => {
    window.postMessage({ type: "MEC_GET_ACCOUNTS" }, "*");
  };

  const handleImport = async () => {
    if (!password) return;
    setLoading(true);
    try {
      const wallets = accounts.map((a, i) => ({
        label: a.name || `Extension Account ${i}`,
        address: a.address,
        password,
        network,
      }));
      const resp = await authFetch("/api/wallets/import-extension", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallets }),
      });
      const result = await resp.json();
      toast({ title: "Extension accounts imported", description: `${result.imported} imported, ${result.skipped} skipped.` });
      onImported();
      setOpen(false);
      setAccounts([]); setPassword("");
    } catch (err) {
      toast({ title: "Import failed", description: String(err), variant: "destructive" });
    }
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 border-border/60">
          <Puzzle className="h-4 w-4" /> Import from Extension
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Import from Chrome Extension</DialogTitle>
          <DialogDescription>Connect your MEC Bridge extension to pull wallet addresses.</DialogDescription>
        </DialogHeader>
        <div className="flex rounded-lg border border-border/60 overflow-hidden text-sm mb-2">
          <button onClick={() => setTab("extension")} className={`flex-1 py-2 flex items-center justify-center gap-2 transition-colors ${tab === "extension" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}>
            <Puzzle className="h-3.5 w-3.5" /> Connect Extension
          </button>
          <button onClick={() => setTab("download")} className={`flex-1 py-2 flex items-center justify-center gap-2 border-l border-border/60 transition-colors ${tab === "download" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}>
            <Download className="h-3.5 w-3.5" /> Download Extension
          </button>
        </div>
        {tab === "download" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Download and install the MEC Bridge Chrome extension to connect your Meta Earth wallets.</p>
            <a href="/api/wallets/bridge-extension.zip" download>
              <Button className="w-full gap-2"><Download className="h-4 w-4" /> Download MEC Bridge Extension</Button>
            </a>
          </div>
        ) : (
          <div className="space-y-4">
            <Button variant="outline" className="w-full gap-2" onClick={requestAccounts}>
              <Puzzle className="h-4 w-4" /> Request Accounts from Extension
            </Button>
            {accounts.length > 0 && (
              <>
                <div className="space-y-1 max-h-[160px] overflow-auto border border-border/50 rounded p-2">
                  {accounts.map((a, i) => (
                    <div key={i} className="font-mono text-xs p-1 text-muted-foreground">
                      <span className="text-primary mr-2">{a.name || `Account ${i}`}</span>{a.address.slice(0, 12)}…{a.address.slice(-8)}
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <Label>Encryption Password</Label>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Secure these wallets" />
                </div>
                <div className="space-y-2">
                  <Label>Network</Label>
                  <Select value={network} onValueChange={setNetwork}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mainnet">Mainnet</SelectItem>
                      <SelectItem value="testnet">Testnet</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button className="w-full" onClick={handleImport} disabled={loading || !password}>
                  {loading ? "Importing..." : `Import ${accounts.length} Wallet${accounts.length !== 1 ? "s" : ""}`}
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Bulk import dialog (mnemonic + private key tabs) ────────────────────────
function BulkImportDialog({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"mnemonic" | "key">("mnemonic");
  const [text, setText] = useState("");
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState("mainnet");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; unverified: number; errors: string[] } | null>(null);
  const { toast } = useToast();
  const bulkImport = useBulkImportWallets();

  const lineCount = text.trim().split("\n").filter(l => l.trim()).length;

  const normalizeResult = (data: any) => ({
    imported: (data.verified ?? 0) + (data.unverified ?? 0),
    skipped: data.skipped ?? 0,
    unverified: data.unverified ?? 0,
    errors: (data.skippedDetails ?? []).map((e: any) => `${e.key ?? e.phrase ?? ""}: ${e.reason}`),
  });

  const handleImport = async () => {
    if (!password || !text.trim()) return;
    setLoading(true);
    try {
      if (tab === "mnemonic") {
        const phrases = text.trim().split("\n").map((l: string) => l.trim()).filter(Boolean);
        bulkImport.mutate(
          { data: { mnemonics: phrases.join("\n"), password, network } },
          {
            onSuccess: (data: any) => {
              setResult(normalizeResult(data));
              onImported();
            },
            onError: (err: any) => {
              toast({ title: "Bulk import failed", description: err?.message || "Unknown error", variant: "destructive" });
            }
          }
        );
      } else {
        const keysText = text.trim().split("\n").map((l: string) => l.trim()).filter(Boolean).join("\n");
        const resp = await authFetch("/api/wallets/bulk-import-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keys: keysText, password, network }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "Failed");
        setResult(normalizeResult(data));
        onImported();
      }
    } catch (err) {
      toast({ title: "Import failed", description: String(err), variant: "destructive" });
    }
    setLoading(false);
  };

  const reset = () => { setText(""); setPassword(""); setResult(null); setNetwork("mainnet"); };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 border-border/60">
          <Upload className="h-4 w-4" /> Bulk Import
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Bulk Import Wallets</DialogTitle>
          <DialogDescription>Import multiple wallets at once — one per line.</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-emerald-400">{result.imported}</div>
                <div className="text-xs text-muted-foreground mt-1">Imported</div>
              </div>
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-yellow-400">{result.skipped}</div>
                <div className="text-xs text-muted-foreground mt-1">Skipped</div>
              </div>
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-blue-400">{result.unverified ?? 0}</div>
                <div className="text-xs text-muted-foreground mt-1">Unverified</div>
              </div>
            </div>
            {result.errors?.length > 0 && (
              <div className="space-y-1 max-h-[120px] overflow-auto">
                {result.errors.map((e, i) => (
                  <p key={i} className="text-xs text-destructive">{e}</p>
                ))}
              </div>
            )}
            <Button className="w-full" onClick={() => { reset(); setOpen(false); }}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex rounded-lg border border-border/60 overflow-hidden text-sm">
              <button onClick={() => setTab("mnemonic")} className={`flex-1 py-2 flex items-center justify-center gap-2 transition-colors ${tab === "mnemonic" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}>
                <BookText className="h-3.5 w-3.5" /> Mnemonic Phrases
              </button>
              <button onClick={() => setTab("key")} className={`flex-1 py-2 flex items-center justify-center gap-2 border-l border-border/60 transition-colors ${tab === "key" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}>
                <KeyRound className="h-3.5 w-3.5" /> Private Keys
              </button>
            </div>
            <div className="space-y-2">
              <Label>{tab === "mnemonic" ? "Mnemonic Phrases (one per line)" : "Private Keys (one per line)"}</Label>
              <textarea
                className="w-full h-32 bg-background border border-border rounded-md px-3 py-2 text-sm font-mono resize-none outline-none focus:border-primary placeholder:text-muted-foreground"
                placeholder={tab === "mnemonic" ? "word1 word2 ... word12\nword1 word2 ... word24" : "64-char hex, 0x-prefixed hex, or Base64 — one per line"}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              {lineCount > 0 && (
                <p className="text-xs text-muted-foreground">{lineCount} {tab === "mnemonic" ? "phrase" : "key"}{lineCount !== 1 ? "s" : ""} detected</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Encryption Password</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Secure all wallets" />
              </div>
              <div className="space-y-2">
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
            <Button className="w-full gap-2" onClick={handleImport} disabled={loading || !password || !text.trim()}>
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {loading ? "Importing..." : `Import ${lineCount} ${tab === "mnemonic" ? "Phrase" : "Key"}${lineCount !== 1 ? "s" : ""}`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Staking rewards panel ─────────────────────────────────────────────────────
function WalletStakingPanel({ id }: { id: number }) {
  const { data, isLoading, refetch, isFetching } = useGetWalletStakingRewards(id);
  const rewards = data?.rewards ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="bg-background/50 border-t border-border/40">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/30">
        <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          <Coins className="h-3 w-3 text-amber-400" />
          {rewards.length === 0 ? "No staking rewards" : `${rewards.length} validator${rewards.length !== 1 ? "s" : ""} — Total: ${data?.totalMEC ?? "0"} MEC`}
        </span>
        <button onClick={() => refetch()} disabled={isFetching} className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50" title="Refresh">
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>
      {rewards.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow className="border-border/30 hover:bg-transparent">
              <TableHead className="text-xs py-2 pl-4">Validator</TableHead>
              <TableHead className="text-xs py-2">Rewards (MEC)</TableHead>
              <TableHead className="text-xs py-2 pr-4">Raw Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rewards.map((r: any, i: number) => (
              <TableRow key={i} className="border-border/20 hover:bg-muted/30">
                <TableCell className="py-2 pl-4 font-mono text-xs text-muted-foreground">
                  {r.validatorAddress.slice(0, 16)}…{r.validatorAddress.slice(-6)}
                </TableCell>
                <TableCell className="py-2 font-mono text-xs text-amber-400">
                  {parseFloat(r.amount).toFixed(6)} MEC
                </TableCell>
                <TableCell className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                  {r.amountRaw}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ─── Transaction history panel ────────────────────────────────────────────────
function WalletTxHistory({ id }: { id: number }) {
  const { data, isLoading, refetch, isFetching } = useGetWalletTransactions(id);
  const txs = data?.transactions ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="bg-background/50 border-t border-border/40">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/30">
        <span className="text-xs font-medium text-muted-foreground">
          {txs.length === 0 ? "No transactions found" : `${txs.length} recent transaction${txs.length !== 1 ? "s" : ""}`}
        </span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {txs.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow className="border-border/30 hover:bg-transparent">
              <TableHead className="text-xs py-2 pl-4 w-6"></TableHead>
              <TableHead className="text-xs py-2">Amount</TableHead>
              <TableHead className="text-xs py-2">Counterpart</TableHead>
              <TableHead className="text-xs py-2">Memo</TableHead>
              <TableHead className="text-xs py-2">Date</TableHead>
              <TableHead className="text-xs py-2 pr-4">Tx Hash</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {txs.map((tx: any) => (
              <TableRow key={tx.txHash} className="border-border/20 hover:bg-muted/30">
                <TableCell className="py-2 pl-4">
                  {tx.direction === "sent" ? (
                    <ArrowUpRight className="h-3.5 w-3.5 text-rose-400" />
                  ) : (
                    <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                </TableCell>
                <TableCell className="py-2 font-mono text-xs">
                  <span className={tx.direction === "sent" ? "text-rose-400" : "text-emerald-400"}>
                    {tx.direction === "sent" ? "−" : "+"}{parseFloat(tx.amount).toFixed(6)} MEC
                  </span>
                </TableCell>
                <TableCell className="py-2 font-mono text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <span>{tx.counterpart.slice(0, 10)}…{tx.counterpart.slice(-5)}</span>
                    <CopyButton text={tx.counterpart} />
                  </div>
                </TableCell>
                <TableCell className="py-2 text-xs text-muted-foreground max-w-[120px] truncate">
                  {tx.memo || <span className="opacity-40">—</span>}
                </TableCell>
                <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {tx.timestamp ? format(new Date(tx.timestamp), "MMM d, yyyy HH:mm") : "—"}
                </TableCell>
                <TableCell className="py-2 pr-4">
                  <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                    <span>{tx.txHash.slice(0, 8)}…</span>
                    <CopyButton text={tx.txHash} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Wallets() {
  const { data: wallets, isLoading } = useListWallets();
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
  const [expandedTxWallet, setExpandedTxWallet] = useState<number | null>(null);
  const [expandedStakingWallet, setExpandedStakingWallet] = useState<number | null>(null);

  // ─── Selection state ────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListWalletsQueryKey() });

  const allIds = wallets?.map(w => w.id) ?? [];
  const allSelected = allIds.length > 0 && allIds.every(id => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  };

  const toggleSelect = (id: number) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };

  const handleBulkMonitor = async (monitored: boolean) => {
    setBulkLoading(true);
    try {
      const resp = await authFetch("/api/wallets/bulk-monitor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletIds: Array.from(selected), monitored }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      toast({
        title: monitored ? "Wallets set to monitored" : "Wallets removed from monitoring",
        description: `${selected.size} wallet${selected.size !== 1 ? "s" : ""} updated.`,
      });
      invalidate();
      setSelected(new Set());
    } catch (err) {
      toast({ title: "Failed to update monitoring", description: String(err), variant: "destructive" });
    }
    setBulkLoading(false);
  };

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

  const handleDerivedImport = async (accounts: { address: string; hdIndex: number; hdPath: string }[], mnemonicPhrase: string, password: string) => {
    if (!password) return;
    const net = "mainnet";

    const walletList = accounts.map(a => ({
      label: `Account ${a.hdIndex}`,
      mnemonic: mnemonicPhrase,
      address: a.address,
      hdIndex: a.hdIndex,
      password,
      network: net,
    }));

    try {
      const resp = await authFetch("/api/wallets/import-extension", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallets: walletList }),
      });
      const result = await resp.json();
      toast({ title: "Accounts added", description: `${result.imported} imported, ${result.skipped} already existed.` });
      invalidate();
    } catch (err) {
      toast({ title: "Import failed", description: String(err), variant: "destructive" });
    }
  };

  const handleDelete = (id: number) => {
    deleteWallet.mutate({ id }, {
      onSuccess: () => { invalidate(); toast({ title: "Wallet Deleted" }); }
    });
  };

  const monitoredCount = wallets?.filter(w => (w as any).monitored).length ?? 0;

  return (
    <div className="space-y-6 pb-24">
      <div className="flex justify-between items-start flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Wallets</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your Meta Earth Coin wallets.
            {monitoredCount > 0 && (
              <span className="ml-2 text-primary font-medium">{monitoredCount} monitored</span>
            )}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <ExtensionImportDialog onImported={invalidate} />
          <DeriveAccountsDialog onImport={handleDerivedImport} />
          <BulkImportDialog onImported={invalidate} />
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
              <TableHead className="w-10 pl-4">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all wallets"
                  className={someSelected ? "data-[state=unchecked]:bg-primary/20" : ""}
                />
              </TableHead>
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
                  <TableCell className="pl-4"><Skeleton className="h-4 w-4" /></TableCell>
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
                <TableCell colSpan={7} className="h-36 text-center">
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
              wallets?.map((wallet) => {
                const isMonitored = (wallet as any).monitored === true;
                const isSelected = selected.has(wallet.id);
                return (
                  <React.Fragment key={wallet.id}>
                    <TableRow className={`border-border transition-colors ${isSelected ? "bg-primary/5" : ""}`}>
                      <TableCell className="pl-4">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelect(wallet.id)}
                          aria-label={`Select ${wallet.label}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <WalletIcon className="h-4 w-4 text-primary shrink-0" />
                          <span>{wallet.label}</span>
                          {wallet.verified === false ? (
                            <span title="Unverified — address has no on-chain history">
                              <ShieldOff className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                            </span>
                          ) : (
                            <span title="Verified on-chain">
                              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                            </span>
                          )}
                          {isMonitored && (
                            <span title="Monitored by agent scheduler">
                              <Eye className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center">
                            <span className="text-foreground">{wallet.address.slice(0, 10)}…{wallet.address.slice(-6)}</span>
                            <CopyButton text={wallet.address} />
                          </div>
                          {(wallet as any).gcAddress && (
                            <div className="flex items-center text-[10px] text-muted-foreground/60">
                              <span className="mr-1 text-primary/50">on-chain:</span>
                              {(wallet as any).gcAddress.slice(0, 10)}…{(wallet as any).gcAddress.slice(-6)}
                              <CopyButton text={(wallet as any).gcAddress} />
                            </div>
                          )}
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
                          <Button
                            variant="ghost"
                            size="icon"
                            title={isMonitored ? "Remove from monitoring" : "Add to monitoring"}
                            onClick={async () => {
                              await authFetch("/api/wallets/bulk-monitor", {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ walletIds: [wallet.id], monitored: !isMonitored }),
                              });
                              invalidate();
                            }}
                            className={isMonitored ? "text-blue-400 bg-blue-400/10" : "text-muted-foreground hover:text-blue-400"}
                          >
                            {isMonitored ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Staking rewards"
                            onClick={() => {
                              setExpandedStakingWallet(expandedStakingWallet === wallet.id ? null : wallet.id);
                              setExpandedTxWallet(null);
                            }}
                            className={expandedStakingWallet === wallet.id ? "text-amber-400 bg-amber-400/10" : "text-muted-foreground"}
                          >
                            <Coins className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Transaction history"
                            onClick={() => {
                              setExpandedTxWallet(expandedTxWallet === wallet.id ? null : wallet.id);
                              setExpandedStakingWallet(null);
                            }}
                            className={expandedTxWallet === wallet.id ? "text-primary bg-primary/10" : "text-muted-foreground"}
                          >
                            <History className="h-4 w-4" />
                          </Button>
                          <SendDialog wallet={wallet} allWallets={wallets ?? []} />
                          <Button variant="ghost" size="icon" onClick={() => handleDelete(wallet.id)} className="text-destructive hover:bg-destructive/10 hover:text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {expandedStakingWallet === wallet.id && (
                      <TableRow key={`staking-${wallet.id}`} className="border-border hover:bg-transparent">
                        <TableCell colSpan={7} className="p-0">
                          <WalletStakingPanel id={wallet.id} />
                        </TableCell>
                      </TableRow>
                    )}
                    {expandedTxWallet === wallet.id && (
                      <TableRow key={`tx-${wallet.id}`} className="border-border hover:bg-transparent">
                        <TableCell colSpan={7} className="p-0">
                          <WalletTxHistory id={wallet.id} />
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* ─── Floating bulk-action bar ─────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-card border border-border/60 shadow-2xl rounded-2xl px-5 py-3">
          <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">
            {selected.size} wallet{selected.size !== 1 ? "s" : ""} selected
          </span>
          <div className="h-4 w-px bg-border" />
          <Button
            size="sm"
            className="gap-2 bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => handleBulkMonitor(true)}
            disabled={bulkLoading}
          >
            <Eye className="h-3.5 w-3.5" />
            Monitor All
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => handleBulkMonitor(false)}
            disabled={bulkLoading}
          >
            <EyeOff className="h-3.5 w-3.5" />
            Unmonitor
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-muted-foreground"
            onClick={() => setSelected(new Set())}
          >
            <X className="h-3.5 w-3.5" /> Clear
          </Button>
        </div>
      )}
    </div>
  );
}
