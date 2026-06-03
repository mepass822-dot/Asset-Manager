import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";
import passport from "passport";
import session from "express-session";
import type { Express, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";

const getOidcConfig = memoize(
  async () => {
    return await client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      process.env.REPL_ID!
    );
  },
  { maxAge: 3600 * 1000 }
);

function updateUserSession(
  user: Record<string, unknown>,
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers
) {
  user["claims"] = tokens.claims();
  user["access_token"] = tokens.access_token;
  user["refresh_token"] = tokens.refresh_token;
  user["expires_at"] = (user["claims"] as Record<string, unknown>)?.["exp"];
}

async function upsertUser(claims: Record<string, unknown>) {
  await db.insert(users).values({
    id: claims["sub"] as string,
    email: claims["email"] as string ?? null,
    firstName: claims["first_name"] as string ?? null,
    lastName: claims["last_name"] as string ?? null,
    profileImageUrl: claims["profile_image_url"] as string ?? null,
  }).onConflictDoUpdate({
    target: users.id,
    set: {
      email: claims["email"] as string ?? null,
      firstName: claims["first_name"] as string ?? null,
      lastName: claims["last_name"] as string ?? null,
      profileImageUrl: claims["profile_image_url"] as string ?? null,
      updatedAt: new Date(),
    },
  });
}

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000;
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      maxAge: sessionTtl,
    },
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  const config = await getOidcConfig();
  const registeredStrategies = new Set<string>();

  const ensureStrategy = (domain: string) => {
    const strategyName = `replitauth:${domain}`;
    if (!registeredStrategies.has(strategyName)) {
      const verify: VerifyFunction = async (tokens, verified) => {
        const user: Record<string, unknown> = {};
        updateUserSession(user, tokens);
        await upsertUser(tokens.claims() as Record<string, unknown>);
        verified(null, user);
      };
      const strategy = new Strategy(
        {
          name: strategyName,
          config,
          scope: "openid email profile offline_access",
          callbackURL: `https://${domain}/api/callback`,
        },
        verify
      );
      passport.use(strategy);
      registeredStrategies.add(strategyName);
    }
  };

  passport.serializeUser((user, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  app.get("/api/login", (req, res, next) => {
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, {
      prompt: "login consent",
      scope: ["openid", "email", "profile", "offline_access"],
    })(req, res, next);
  });

  app.get("/api/callback", (req, res, next) => {
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, {
      successReturnToOrRedirect: "/",
      failureRedirect: "/api/login",
    })(req, res, next);
  });

  app.get("/api/logout", (req, res) => {
    req.logout(() => {
      client.buildEndSessionUrl(config, {
        client_id: process.env.REPL_ID!,
        post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
      }).then((url) => {
        res.redirect(url.href);
      }).catch(() => {
        res.redirect("/");
      });
    });
  });

  app.get("/api/auth/user", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) { res.status(401).json({ message: "Unauthorized" }); return; }
      const rows = await db.select().from(users).where(eq(users.id, userId));
      res.json(rows[0] ?? null);
    } catch {
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  const user = req.user as Record<string, unknown> | undefined;

  if (!req.isAuthenticated() || !user?.["expires_at"]) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  if (now <= (user["expires_at"] as number)) {
    return next();
  }

  const refreshToken = user["refresh_token"] as string | undefined;
  if (!refreshToken) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshToken);
    updateUserSession(user, tokenResponse);
    return next();
  } catch {
    res.status(401).json({ message: "Unauthorized" });
  }
};
