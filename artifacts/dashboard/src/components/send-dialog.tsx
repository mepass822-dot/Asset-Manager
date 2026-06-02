import { useState } from "react";
import { Send, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface Wallet {
  id: number;
  label: string;
  address: string;
  network: string;
}

interface SendDialogProps {
  wallet: Wallet;
  allWallets?: Wallet[];
}

export function SendDialog({ wallet, allWallets = [] }: SendDialogProps) {
  const [open, setOpen] = useState(false);
  const [toMode, setToMode] = useState<"wallet" | "address">("wallet");
  const [selectedWalletId, setSelectedWalletId] = useState<string>("");
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [password, setPassword] = useState("");
  const [memo, setMemo] = useState("");
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const { toast } = useToast();

  const otherWallets = allWallets.filter((w) => w.id !== wallet.id);

  const reset = () => {
    setToAddress(""); setAmount(""); setPassword(""); setMemo("");
    setTxHash(null); setLoading(false); setSelectedWalletId("");
    setToMode(otherWallets.length > 0 ? "wallet" : "address");
  };

  const resolvedToAddress = (() => {
    if (toMode === "wallet" && selectedWalletId) {
      return allWallets.find((w) => w.id === Number(selectedWalletId))?.address ?? "";
    }
    return toAddress;
  })();

  const canSend = !loading && !!resolvedToAddress && !!amount && !!password;

  const handleSend = async () => {
    if (!canSend) return;
    setLoading(true);
    try {
      const resp = await fetch(`/api/wallets/${wallet.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toAddress: resolvedToAddress,
          amountMEC: parseFloat(amount),
          masterPassword: password,
          memo,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg: string = data.error || "Transaction failed";
        if (msg.includes("does not exist on chain")) {
          throw new Error(
            "The sender wallet has no on-chain balance yet. Fund this address with MEC before sending."
          );
        }
        throw new Error(msg);
      }
      setTxHash(data.txHash);
      toast({
        title: "Transaction Sent!",
        description: `TX: ${data.txHash.slice(0, 16)}... (block ${data.height})`,
      });
    } catch (err) {
      toast({ title: "Send Failed", description: String(err), variant: "destructive" });
    }
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="text-primary hover:bg-primary/10" title="Send MEC">
          <Send className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Send MEC</DialogTitle>
          <DialogDescription>
            From: <span className="font-mono text-xs text-primary">{wallet.label}</span>
            <span className="text-muted-foreground ml-1">({wallet.address.slice(0, 10)}...{wallet.address.slice(-6)})</span>
          </DialogDescription>
        </DialogHeader>

        {txHash ? (
          <div className="py-4 space-y-3">
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-center space-y-2">
              <p className="text-sm font-medium text-primary">Transaction Broadcast!</p>
              <p className="text-xs text-muted-foreground">TX Hash:</p>
              <p className="font-mono text-xs break-all text-foreground">{txHash}</p>
            </div>
            <DialogFooter>
              <Button onClick={() => { setOpen(false); reset(); }}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            {/* Recipient */}
            <div className="grid gap-2">
              <Label>Recipient</Label>

              {/* Mode toggle */}
              {otherWallets.length > 0 && (
                <div className="flex rounded-lg border border-border/60 overflow-hidden text-xs mb-1">
                  <button
                    onClick={() => setToMode("wallet")}
                    className={`flex-1 py-1.5 transition-colors ${toMode === "wallet" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                  >
                    My Wallets
                  </button>
                  <button
                    onClick={() => setToMode("address")}
                    className={`flex-1 py-1.5 transition-colors border-l border-border/60 ${toMode === "address" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                  >
                    External Address
                  </button>
                </div>
              )}

              {toMode === "wallet" && otherWallets.length > 0 ? (
                <Select value={selectedWalletId} onValueChange={setSelectedWalletId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select destination wallet…" />
                  </SelectTrigger>
                  <SelectContent>
                    {otherWallets.map((w) => (
                      <SelectItem key={w.id} value={String(w.id)}>
                        <span className="font-medium">{w.label}</span>
                        <span className="text-muted-foreground ml-2 font-mono text-xs">
                          {w.address.slice(0, 10)}…{w.address.slice(-6)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="font-mono text-xs"
                  value={toAddress}
                  onChange={(e) => setToAddress(e.target.value)}
                  placeholder="me1... or gc1..."
                />
              )}

              {resolvedToAddress && (
                <p className="text-xs text-muted-foreground font-mono break-all">
                  → {resolvedToAddress}
                </p>
              )}
            </div>

            {/* Amount */}
            <div className="grid gap-2">
              <Label>Amount (MEC)</Label>
              <Input
                type="number"
                min="0"
                step="0.0001"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0001"
              />
              <p className="text-xs text-muted-foreground">Fee: 1 GC · Gas: 5,000,000</p>
            </div>

            {/* Password */}
            <div className="grid gap-2">
              <Label>Encryption Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password used when importing this wallet"
              />
            </div>

            {/* Memo */}
            <div className="grid gap-2">
              <Label>Memo <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. withdrawal" />
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                disabled={!canSend}
                onClick={handleSend}
                className="gap-2"
              >
                {loading ? (
                  <>
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
                    Broadcasting...
                  </>
                ) : (
                  <><Send className="h-3.5 w-3.5" /> Send {amount || "0"} MEC</>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
