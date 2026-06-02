import { useState } from "react";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Wallet, Shield } from "lucide-react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleSignIn = async () => {
    if (!email || !password) {
      toast({ title: "Missing fields", description: "Please enter your email and password.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      const msg = err?.code === "auth/invalid-credential" || err?.code === "auth/user-not-found" || err?.code === "auth/wrong-password"
        ? "Invalid email or password."
        : err?.message ?? "Sign in failed.";
      toast({ title: "Sign in failed", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!email || !password) {
      toast({ title: "Missing fields", description: "Please enter your email and password.", variant: "destructive" });
      return;
    }
    if (password.length < 6) {
      toast({ title: "Weak password", description: "Password must be at least 6 characters.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      const msg = err?.code === "auth/email-already-in-use"
        ? "This email is already registered. Please sign in instead."
        : err?.message ?? "Registration failed.";
      toast({ title: "Registration failed", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === "Enter") action();
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
              <span>Secured with Firebase Authentication</span>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="signin">
              <TabsList className="w-full mb-4">
                <TabsTrigger value="signin" className="flex-1">Sign In</TabsTrigger>
                <TabsTrigger value="register" className="flex-1">Register</TabsTrigger>
              </TabsList>

              <TabsContent value="signin" className="space-y-4">
                <CardTitle className="text-lg">Welcome back</CardTitle>
                <CardDescription>Enter your credentials to access the dashboard.</CardDescription>
                <div className="space-y-3 pt-2">
                  <div className="space-y-1">
                    <Label htmlFor="signin-email">Email</Label>
                    <Input
                      id="signin-email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleSignIn)}
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="signin-password">Password</Label>
                    <Input
                      id="signin-password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleSignIn)}
                      disabled={loading}
                    />
                  </div>
                  <Button className="w-full" onClick={handleSignIn} disabled={loading}>
                    {loading ? "Signing in…" : "Sign In"}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="register" className="space-y-4">
                <CardTitle className="text-lg">Create account</CardTitle>
                <CardDescription>Register to access the wallet agent dashboard.</CardDescription>
                <div className="space-y-3 pt-2">
                  <div className="space-y-1">
                    <Label htmlFor="reg-email">Email</Label>
                    <Input
                      id="reg-email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleRegister)}
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="reg-password">Password</Label>
                    <Input
                      id="reg-password"
                      type="password"
                      placeholder="Min. 6 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleRegister)}
                      disabled={loading}
                    />
                  </div>
                  <Button className="w-full" onClick={handleRegister} disabled={loading}>
                    {loading ? "Creating account…" : "Create Account"}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
