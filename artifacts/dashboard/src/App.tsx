import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Wallets from "@/pages/wallets";
import Agent from "@/pages/agent";
import AgentChat from "@/pages/agent-chat";
import Rules from "@/pages/rules";
import Logs from "@/pages/logs";
import Whitelist from "@/pages/whitelist";
import Login from "@/pages/login";
import { AuthProvider, useAuth } from "@/contexts/auth-context";

const queryClient = new QueryClient();

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/wallets" component={Wallets} />
        <Route path="/agent" component={Agent} />
        <Route path="/agent/chat" component={AgentChat} />
        <Route path="/rules" component={Rules} />
        <Route path="/logs" component={Logs} />
        <Route path="/whitelist" component={Whitelist} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <span className="relative flex h-4 w-4">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-4 w-4 bg-primary"></span>
          </span>
          <span className="text-sm">Loading…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthGuard>
              <Router />
            </AuthGuard>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
