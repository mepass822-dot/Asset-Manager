import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

interface Wallet {
  id: number;
  label: string;
  address: string;
  network: string;
}

export function SendDialog({ wallet }: { wallet: Wallet }) {
  const [open, setOpen] = useState(false);
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [password, setPassword] = useState("");
  const [memo, setMemo] = useState("");
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const { toast } = useToast();

  const reset = () => {
    setToAddress(""); setAmount(""); setPassword(""); setMemo("");
    setTxHash(null); setLoading(false);
  };

  const handleSend = async () => {
    if (!toAddress || !amount || !password) return;
    setLoading(true);
    try {
      const resp = await fetch(`/api/wallets/${wallet.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toAddress,
          amountMEC: parseFloat(amount),
          masterPassword: password,
          memo,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Transaction failed");
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
      <DialogContent className="sm:max-w-[420px]">
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
            <div className="grid gap-2">
              <Label>To Address</Label>
              <Input
                className="font-mono text-xs"
                value={toAddress}
                onChange={(e) => setToAddress(e.target.value)}
                placeholder="me1..."
              />
            </div>
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
              <p className="text-xs text-muted-foreground">Fee: 0.02 MEC · Gas: 500,000</p>
            </div>
            <div className="grid gap-2">
              <Label>Encryption Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password used when importing this wallet"
              />
            </div>
            <div className="grid gap-2">
              <Label>Memo <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. withdrawal" />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                disabled={loading || !toAddress || !amount || !password}
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
