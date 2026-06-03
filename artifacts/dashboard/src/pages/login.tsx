import { Wallet, Shield } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function Login() {
  const handleLogin = () => {
    window.location.href = "/api/auth/login";
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2 mb-4">
            <div className="p-2 rounded-lg bg-primary/10">
              <Wallet className="h-8 w-8 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">MEC Agent</h1>
          <p className="text-muted-foreground text-sm">Autonomous Meta Earth Wallet Management</p>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Shield className="h-3 w-3" />
              <span>Secured Authentication</span>
            </div>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={handleLogin}>
              Log in
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
