import { useState, useRef, useEffect } from "react";
import { authFetch } from "@/lib/firebase";
import { useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Bot, User, Send, Sparkles, Trash2, Wifi } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Message = {
  role: "user" | "assistant";
  content: string;
  suggestedActions?: string[];
};

const WELCOME: Message = {
  role: "assistant",
  content:
    "I am the NVIDIA-powered Meta Earth Wallet Agent. I have full memory of our conversation — ask me about wallet balances, strategy, sweep configuration, staking rewards, or let me help plan automated operations.",
};

const QUICK_PROMPTS = [
  "Summarize my wallet portfolio",
  "How does the dividend sweep work?",
  "What rules should I configure for auto-sweep?",
  "Explain staking rewards on me-chain",
  "Is my whitelist configured correctly?",
];

function renderContent(text: string) {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    if (line.startsWith("### ")) return <h3 key={i} className="font-bold text-sm mt-2 mb-1">{line.slice(4)}</h3>;
    if (line.startsWith("## ")) return <h2 key={i} className="font-bold text-base mt-2 mb-1">{line.slice(3)}</h2>;
    if (line.startsWith("- ") || line.startsWith("• ")) return <li key={i} className="ml-3 list-disc">{line.slice(2)}</li>;
    if (line.startsWith("**") && line.endsWith("**")) return <p key={i} className="font-semibold">{line.slice(2, -2)}</p>;
    if (line === "") return <br key={i} />;
    // Inline bold: replace **text** with <strong>
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <p key={i}>
        {parts.map((part, j) =>
          part.startsWith("**") && part.endsWith("**")
            ? <strong key={j}>{part.slice(2, -2)}</strong>
            : part
        )}
      </p>
    );
  });
}

export default function AgentChat() {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [useContext, setUseContext] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const chatMutation = useMutation({
    mutationFn: async ({ message, history }: { message: string; history: Message[] }) => {
      const r = await authFetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          walletContext: useContext,
          history: history.filter((m) => m.role !== "assistant" || m.content !== WELCOME.content).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });
      if (!r.ok) {
        const d = await r.json();
        throw new Error(d.error || "AI request failed");
      }
      return r.json() as Promise<{ reply: string; suggestedActions: string[] }>;
    },
    onSuccess: (data) => {
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply, suggestedActions: data.suggestedActions }]);
    },
    onError: (err: Error) => {
      toast({ title: "Chat error", description: err.message, variant: "destructive" });
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err.message}` }]);
    },
  });

  useEffect(() => {
    const el = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, chatMutation.isPending]);

  const handleSend = (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || chatMutation.isPending) return;
    const newMessages: Message[] = [...messages, { role: "user", content: msg }];
    setMessages(newMessages);
    setInput("");
    chatMutation.mutate({ message: msg, history: messages });
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const clearChat = () => {
    setMessages([WELCOME]);
    setInput("");
  };

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col space-y-3">
      {/* Header */}
      <div className="flex justify-between items-start shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agent Chat</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            NVIDIA Llama 3.1 · full conversation memory · real-time wallet context
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

      {/* Quick prompts — only show when only the welcome message is visible */}
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

      {/* Chat area */}
      <Card className="flex-1 flex flex-col bg-card border-border/50 min-h-0 overflow-hidden">
        <ScrollArea className="flex-1 p-4" ref={scrollRef}>
          <div className="space-y-5 pb-2">
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
                <div
                  className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold ${
                    msg.role === "user" ? "bg-secondary text-secondary-foreground" : "bg-primary text-primary-foreground"
                  }`}
                >
                  {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                </div>
                <div className={`max-w-[78%] space-y-2 ${msg.role === "user" ? "items-end" : "items-start"} flex flex-col`}>
                  <div
                    className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-tr-sm"
                        : "bg-muted/60 border border-border/40 rounded-tl-sm"
                    }`}
                  >
                    <div className={`space-y-0.5 ${msg.role === "user" ? "" : "prose-sm"}`}>
                      {renderContent(msg.content)}
                    </div>
                  </div>
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
            ))}

            {chatMutation.isPending && (
              <div className="flex gap-3">
                <div className="shrink-0 h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                  <Bot className="h-4 w-4 animate-pulse" />
                </div>
                <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-muted/60 border border-border/40 flex items-center gap-1">
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
              placeholder="Ask about balances, sweep strategy, rules, staking…"
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
              {messages.filter((m) => m.role === "user").length} message{messages.filter((m) => m.role === "user").length !== 1 ? "s" : ""} in session
            </span>
            <span className="text-[10px] text-muted-foreground">Enter to send · Shift+Enter for newline</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
