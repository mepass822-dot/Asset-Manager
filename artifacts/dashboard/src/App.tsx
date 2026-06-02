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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
