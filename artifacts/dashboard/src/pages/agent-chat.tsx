import { useState, useRef, useEffect } from "react";
import { useAgentChat } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, User, Send, Sparkles } from "lucide-react";

type Message = {
  role: "user" | "assistant";
  content: string;
  suggestedActions?: string[];
};

export default function AgentChat() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "I am the NVIDIA-powered Meta Earth Wallet Agent. Ask me about wallet balances, strategy, or let me plan automated withdrawals for you." }
  ]);
  const [input, setInput] = useState("");
  const [useContext, setUseContext] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const chatMutation = useAgentChat();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    
    const userMsg = input;
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setInput("");

    chatMutation.mutate(
      { data: { message: userMsg, walletContext: useContext } },
      {
        onSuccess: (data) => {
          setMessages(prev => [...prev, { 
            role: "assistant", 
            content: data.reply,
            suggestedActions: data.suggestedActions 
          }]);
        }
      }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col space-y-4">
      <div className="flex justify-between items-center shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agent Chat</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Consult the NVIDIA AI for strategy and operations.
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Label htmlFor="context" className="text-sm font-medium">Include Wallet Context</Label>
          <Switch id="context" checked={useContext} onCheckedChange={setUseContext} />
        </div>
      </div>

      <Card className="flex-1 flex flex-col bg-card border-border/50 min-h-0">
        <ScrollArea className="flex-1 p-4" ref={scrollRef}>
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-3 max-w-[80%] ${msg.role === 'user' ? 'ml-auto flex-row-reverse' : ''}`}>
                <div className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${msg.role === 'user' ? 'bg-secondary' : 'bg-primary text-primary-foreground'}`}>
                  {msg.role === 'user' ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                </div>
                <div className={`p-3 rounded-lg text-sm ${msg.role === 'user' ? 'bg-secondary text-secondary-foreground' : 'bg-background border border-border/50'}`}>
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                  {msg.suggestedActions && msg.suggestedActions.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {msg.suggestedActions.map((action, j) => (
                        <Badge key={j} variant="outline" className="cursor-pointer hover:bg-primary hover:text-primary-foreground transition-colors" onClick={() => setInput(action)}>
                          <Sparkles className="h-3 w-3 mr-1" /> {action}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {chatMutation.isPending && (
              <div className="flex gap-3 max-w-[80%]">
                <div className="shrink-0 h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                  <Bot className="h-4 w-4 animate-pulse" />
                </div>
                <div className="p-3 rounded-lg text-sm bg-background border border-border/50 flex items-center">
                  <span className="flex space-x-1">
                    <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
        <div className="p-4 border-t border-border/50 shrink-0">
          <div className="flex gap-2">
            <Input 
              value={input} 
              onChange={e => setInput(e.target.value)} 
              onKeyDown={handleKeyDown}
              placeholder="Ask the agent to analyze balances, plan sweeps..." 
              className="flex-1 bg-background"
              disabled={chatMutation.isPending}
            />
            <Button size="icon" onClick={handleSend} disabled={chatMutation.isPending || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// Inline badge component since it might not be exported above
function Badge({ children, variant = "default", className = "", ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "secondary" | "destructive" | "outline" }) {
  const base = "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2";
  const variants = {
    default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
    secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
    destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
    outline: "text-foreground",
  };
  return <div className={`${base} ${variants[variant]} ${className}`} {...props}>{children}</div>;
}
