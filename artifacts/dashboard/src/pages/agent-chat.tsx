import { useState, useRef, useEffect } from "react";
import { authFetch } from "@/lib/firebase";
import { useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Bot, User, Send, Sparkles, Trash2, Wifi, Zap, CheckCircle2,
  XCircle, Loader2, ShieldAlert, ArrowRight, Wallet, Lock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProposalWallet {
  id: string;
  label: string;
  address: string;
  balance: string;
  stakingRewards: string;
}

interface ActionProposal {
  type: "sweep_all" | "claim_staking" | "claim_then_sweep";
  description: string;
  wallets: ProposalWallet[];
  masterAddress: string;
  totalEstimatedMEC: string;
  requiresPassword: true;
}

interface ExecutionLog {
  id: string;
  walletLabel: string | null;
  action: string;
  status: string;
  txHash: string | null;
  amount: string | null;
  message: string;
}

type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; suggestedActions: string[]; actionProposal: ActionProposal | null }
  | { role: "execution_result"; executed: number; skipped: number; masterAddress: string; logs: ExecutionLog[]; dryRun: boolean };

// ── Constants ─────────────────────────────────────────────────────────────────

const WELCOME: Message = {
  role: "assistant",
  content: "I'm the Meta Earth Wallet Agent — powered by NVIDIA Llama 3.1.\n\nI can answer questions **and execute real on-chain actions**. Try commands like:\n- \"Withdraw all balances to master address\"\n- \"Claim staking rewards\"\n- \"Claim rewards then sweep everything to master\"\n- \"What's my total portfolio balance?\"",
  suggestedActions: [],
  actionProposal: null,
};

const ACTION_LABELS: Record<ActionProposal["type"], string> = {
  sweep_all: "Sweep All Balances",
  claim_staking: "Claim Staking Rewards",
  claim_then_sweep: "Claim & Sweep All",
};

const ACTION_COLORS: Record<ActionProposal["type"], string> = {
  sweep_all: "text-orange-400",
  claim_staking: "text-blue-400",
  claim_then_sweep: "text-purple-400",
};

// ── Markdown renderer ─────────────────────────────────────────────────────────

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part
  );
}

function renderContent(text: string) {
  return text.split("\n").map((line, i) => {
    if (line.startsWith("### ")) return <h3 key={i} className="font-bold text-sm mt-2 mb-1">{line.slice(4)}</h3>;
    if (line.startsWith("## ")) return <h2 key={i} className="font-semibold text-base mt-2 mb-1">{line.slice(3)}</h2>;
    if (line.startsWith("- ") || line.startsWith("• ")) {
      return <li key={i} className="ml-4 list-disc text-sm leading-relaxed">{renderInline(line.slice(2))}</li>;
    }
    if (line === "") return <br key={i} />;
    return <p key={i} className="text-sm leading-relaxed">{renderInline(line)}</p>;
  });
}

// ── Confirmation Card ─────────────────────────────────────────────────────────

function ConfirmationCard({
  proposal,
  onExecute,
  onCancel,
  isExecuting,
}: {
  proposal: ActionProposal;
  onExecute: (password: string, dryRun: boolean) => void;
  onCancel: () => void;
  isExecuting: boolean;
}) {
  const [password, setPassword] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState("");

  const handleExecute = () => {
    if (!password.trim()) { setError("Encryption password is required"); return; }
    setError("");
    onExecute(password, dryRun);
  };

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden w-full">
      <div className="px-4 py-3 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2">
        <Zap className={`h-4 w-4 ${ACTION_COLORS[proposal.type]}`} />
        <span className={`font-semibold text-sm ${ACTION_COLORS[proposal.type]}`}>
          {ACTION_LABELS[proposal.type]}
        </span>
        <Badge variant="outline" className="ml-auto text-xs border-amber-500/30 text-amber-400">
          Confirm to Execute
        </Badge>
      </div>

      <div className="px-4 py-3">
        <p className="text-sm text-muted-foreground">{proposal.description}</p>
      </div>

      {proposal.wallets.length > 0 ? (
        <div className="px-4 pb-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {proposal.wallets.length} wallet{proposal.wallets.length !== 1 ? "s" : ""} affected
          </p>
          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
            {proposal.wallets.map((w) => (
              <div key={w.id} className="flex items-center gap-2 text-xs bg-background/60 rounded-lg px-3 py-2 border border-border/40">
                <Wallet className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="font-medium truncate max-w-[100px]">{w.label}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0 ml-auto" />
                <span className="text-primary font-mono shrink-0">
                  {proposal.type === "claim_staking"
                    ? `${parseFloat(w.stakingRewards || "0").toFixed(4)} MEC`
                    : `${parseFloat(w.balance || "0").toFixed(4)} MEC`}
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between px-3 py-2 bg-primary/5 rounded-lg border border-primary/20">
            <span className="text-xs font-medium text-muted-foreground">Estimated total</span>
            <span className="text-sm font-bold text-primary font-mono">
              {parseFloat(proposal.totalEstimatedMEC).toFixed(6)} MEC
            </span>
          </div>

          {proposal.masterAddress && (
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 rounded-lg">
              <span className="text-xs text-muted-foreground shrink-0">→ Master:</span>
              <span className="text-xs font-mono text-foreground/70 truncate">{proposal.masterAddress}</span>
            </div>
          )}

          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && handleExecute()}
              placeholder="Encryption password"
              disabled={isExecuting}
              className="w-full pl-9 pr-4 py-2 bg-background/80 border border-border/60 rounded-lg text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-all placeholder:text-muted-foreground disabled:opacity-50"
            />
          </div>
          {error && <p className="text-xs text-destructive flex items-center gap-1"><XCircle className="h-3 w-3" />{error}</p>}

          <div className="flex items-center gap-2">
            <Switch id={`dry-${proposal.type}`} checked={dryRun} onCheckedChange={setDryRun} disabled={isExecuting} />
            <Label htmlFor={`dry-${proposal.type}`} className="text-xs text-muted-foreground cursor-pointer">
              Dry run (simulate, no broadcast)
            </Label>
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" size="sm" className="flex-1" onClick={onCancel} disabled={isExecuting}>
              Cancel
            </Button>
            <Button size="sm" className="flex-1 gap-1.5" onClick={handleExecute} disabled={isExecuting || !password.trim()}>
              {isExecuting
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Executing…</>
                : <><Zap className="h-3.5 w-3.5" />{dryRun ? "Simulate" : "Execute Now"}</>}
            </Button>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-4">
          <p className="text-sm text-muted-foreground italic">
            No wallets currently meet the minimum sweep threshold. Check your balances or adjust the minimum in Agent Settings.
          </p>
          <Button variant="outline" size="sm" className="mt-2 w-full" onClick={onCancel}>Dismiss</Button>
        </div>
      )}
    </div>
  );
}

// ── Execution Result Card ─────────────────────────────────────────────────────

function ExecutionResultCard({ msg }: { msg: Extract<Message, { role: "execution_result" }> }) {
  const successLogs = msg.logs.filter((l) => l.status === "success" || l.status === "dry_run");
  const errorLogs = msg.logs.filter((l) => l.status === "error" || l.status === "blocked");
  const ok = msg.executed > 0;

  return (
    <div className={`rounded-xl border overflow-hidden ${ok ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}>
      <div className={`px-4 py-3 border-b flex items-center gap-2 ${ok ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20"}`}>
        {ok ? <CheckCircle2 className="h-4 w-4 text-green-400" /> : <XCircle className="h-4 w-4 text-red-400" />}
        <span className={`font-semibold text-sm ${ok ? "text-green-400" : "text-red-400"}`}>
          {msg.dryRun ? "Simulation Complete" : "Execution Complete"}
        </span>
        <div className="ml-auto flex gap-2">
          {ok && <Badge variant="outline" className="text-xs border-green-500/30 text-green-400">{msg.executed} succeeded</Badge>}
          {msg.skipped > 0 && <Badge variant="outline" className="text-xs border-muted text-muted-foreground">{msg.skipped} skipped</Badge>}
          {errorLogs.length > 0 && <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">{errorLogs.length} failed</Badge>}
        </div>
      </div>

      {successLogs.length > 0 && (
        <div className="px-4 py-3 space-y-2">
          {successLogs.map((log) => (
            <div key={log.id} className="text-xs space-y-0.5">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
                <span className="font-medium">{log.walletLabel ?? "Agent"}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{log.action.replace(/_/g, " ")}</span>
                {log.amount && <span className="ml-auto font-mono text-primary">{parseFloat(log.amount).toFixed(6)} MEC</span>}
              </div>
              {log.txHash && (
                <p className="font-mono text-[10px] text-muted-foreground truncate pl-5">TX: {log.txHash}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {errorLogs.length > 0 && (
        <div className="px-4 pb-3 space-y-1.5 border-t border-red-500/10 pt-2">
          {errorLogs.map((log) => (
            <div key={log.id} className="text-xs flex items-start gap-1.5">
              <XCircle className="h-3 w-3 text-red-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-medium">{log.walletLabel ?? "Agent"}</span>
                <span className="text-muted-foreground ml-1">{log.message}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!msg.dryRun && ok && (
        <div className="px-4 pb-3">
          <p className="text-xs text-muted-foreground">→ Destination: <span className="font-mono">{msg.masterAddress}</span></p>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function AgentChat() {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [useContext, setUseContext] = useState(true);
  const [activeProposalIndex, setActiveProposalIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    const el = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const chatMutation = useMutation({
    mutationFn: async ({ message, history }: { message: string; history: Message[] }) => {
      const r = await authFetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          walletContext: useContext,
          history: history
            .filter((m): m is Extract<Message, { role: "user" | "assistant" }> => m.role === "user" || m.role === "assistant")
            .filter((m) => m.role !== "assistant" || m.content !== WELCOME.content)
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || "AI request failed"); }
      return r.json() as Promise<{ reply: string; suggestedActions: string[]; actionProposal: ActionProposal | null }>;
    },
    onSuccess: (data, _vars, _ctx) => {
      const newMsg: Message = {
        role: "assistant",
        content: data.reply,
        suggestedActions: data.suggestedActions ?? [],
        actionProposal: data.actionProposal ?? null,
      };
      setMessages((prev) => {
        const next = [...prev, newMsg];
        if (data.actionProposal) setActiveProposalIndex(next.length - 1);
        return next;
      });
    },
    onError: (err: Error) => {
      toast({ title: "Chat error", description: err.message, variant: "destructive" });
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err.message}`, suggestedActions: [], actionProposal: null }]);
    },
  });

  const executeMutation = useMutation({
    mutationFn: async ({ type, password, dryRun }: { type: ActionProposal["type"]; password: string; dryRun: boolean }) => {
      const r = await authFetch("/api/agent/execute-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, password, dryRun }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || "Execution failed"); }
      return r.json() as Promise<{ executed: number; skipped: number; masterAddress: string; logs: ExecutionLog[]; dryRun: boolean }>;
    },
    onSuccess: (data) => {
      setActiveProposalIndex(null);
      const result: Message = { role: "execution_result", ...data };
      setMessages((prev) => [...prev, result]);
      toast({
        title: data.dryRun ? "Simulation complete" : "Execution complete",
        description: `${data.executed} action${data.executed !== 1 ? "s" : ""} ${data.dryRun ? "simulated" : "executed"}, ${data.skipped} skipped`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Execution failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSend = (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || chatMutation.isPending) return;
    const newMessages: Message[] = [...messages, { role: "user", content: msg }];
    setMessages(newMessages);
    setInput("");
    setActiveProposalIndex(null);
    chatMutation.mutate({ message: msg, history: messages });
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const clearChat = () => { setMessages([WELCOME]); setInput(""); setActiveProposalIndex(null); };

  const QUICK_PROMPTS = [
    "Withdraw all balances to master address",
    "Claim staking rewards",
    "Claim rewards then sweep to master",
    "What's my portfolio balance?",
    "How does dividend sweep work?",
  ];

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col space-y-3">
      <div className="flex justify-between items-start shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agent Chat</h1>
          <p className="text-muted-foreground mt-1 text-sm flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-primary" />
            NVIDIA Llama 3.1 · full memory · real-time on-chain execution
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Wifi className="h-3.5 w-3.5 text-primary" />
            <Label htmlFor="ctx" className="text-sm">Wallet Context</Label>
            <Switch id="ctx" checked={useContext} onCheckedChange={setUseContext} />
          </div>
          <Button variant="ghost" size="sm" className="text-muted-foreground gap-1.5" onClick={clearChat}>
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-xs text-muted-foreground shrink-0">
        <ShieldAlert className="h-3.5 w-3.5 text-primary shrink-0" />
        <span>This agent can execute <strong className="text-foreground">real on-chain transactions</strong>. Every action requires your encryption password and shows a preview before executing.</span>
      </div>

      {messages.length === 1 && (
        <div className="flex flex-wrap gap-2 shrink-0">
          {QUICK_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() => handleSend(p)}
              className="text-xs px-3 py-1.5 rounded-full border border-border/50 bg-card hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <Card className="flex-1 flex flex-col bg-card border-border/50 min-h-0 overflow-hidden">
        <ScrollArea className="flex-1 p-4" ref={scrollRef}>
          <div className="space-y-5 pb-2">
            {messages.map((msg, i) => {
              if (msg.role === "execution_result") {
                return (
                  <div key={i} className="flex gap-3">
                    <div className="shrink-0 h-8 w-8 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center">
                      <CheckCircle2 className="h-4 w-4" />
                    </div>
                    <div className="flex-1 max-w-[90%]">
                      <ExecutionResultCard msg={msg} />
                    </div>
                  </div>
                );
              }

              if (msg.role === "user") {
                return (
                  <div key={i} className="flex gap-3 flex-row-reverse">
                    <div className="shrink-0 h-8 w-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center">
                      <User className="h-4 w-4" />
                    </div>
                    <div className="max-w-[78%] px-4 py-3 rounded-2xl rounded-tr-sm bg-primary text-primary-foreground text-sm leading-relaxed">
                      {msg.content}
                    </div>
                  </div>
                );
              }

              if (msg.role === "assistant") {
                return (
                  <div key={i} className="flex gap-3">
                    <div className="shrink-0 h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="max-w-[85%] space-y-2 flex flex-col items-start w-full">
                      {msg.content && (
                        <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-muted/60 border border-border/40 text-sm w-full">
                          <div className="space-y-0.5">{renderContent(msg.content)}</div>
                        </div>
                      )}

                      {msg.actionProposal && activeProposalIndex === i && (
                        <ConfirmationCard
                          proposal={msg.actionProposal}
                          onExecute={(password, dryRun) => executeMutation.mutate({ type: msg.actionProposal!.type, password, dryRun })}
                          onCancel={() => setActiveProposalIndex(null)}
                          isExecuting={executeMutation.isPending}
                        />
                      )}

                      {msg.actionProposal && activeProposalIndex !== i && (
                        <button
                          className="text-xs px-3 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 text-amber-400 hover:bg-amber-500/10 transition-colors flex items-center gap-1.5"
                          onClick={() => setActiveProposalIndex(i)}
                        >
                          <Zap className="h-3 w-3" />
                          {ACTION_LABELS[msg.actionProposal.type]} — click to confirm
                        </button>
                      )}

                      {msg.suggestedActions && msg.suggestedActions.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {msg.suggestedActions.map((action, j) => (
                            <Badge
                              key={j}
                              variant="outline"
                              className="cursor-pointer hover:bg-primary hover:text-primary-foreground transition-colors text-xs"
                              onClick={() => handleSend(action)}
                            >
                              <Sparkles className="h-3 w-3 mr-1 shrink-0" />
                              {action}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              return null;
            })}

            {chatMutation.isPending && (
              <div className="flex gap-3">
                <div className="shrink-0 h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                  <Bot className="h-4 w-4 animate-pulse" />
                </div>
                <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-muted/60 border border-border/40 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="p-3 border-t border-border/40 shrink-0 bg-background/60">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question or give a command — e.g. withdraw all balances…"
              className="flex-1 bg-muted/40 border border-border/50 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-all placeholder:text-muted-foreground disabled:opacity-50"
              disabled={chatMutation.isPending}
            />
            <Button
              size="icon"
              className="rounded-xl h-10 w-10 shrink-0"
              onClick={() => handleSend()}
              disabled={chatMutation.isPending || !input.trim()}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1">
            <span className="text-[10px] text-muted-foreground">
              {messages.filter((m) => m.role === "user").length} message{messages.filter((m) => m.role === "user").length !== 1 ? "s" : ""} · Enter to send
            </span>
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Zap className="h-3 w-3 text-primary" /> Execution-capable agent
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
