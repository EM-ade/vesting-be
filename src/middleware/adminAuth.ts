import { Request, Response, NextFunction } from "express";

/**
 * Admin Authentication Middleware
 * Verifies that the request comes from an authorized admin wallet
 * Admin wallets are configured via ADMIN_WALLETS environment variable
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    // Get admin wallet from request (query for GET, body for POST/PUT)
    const adminWallet = req.body?.adminWallet || req.query?.adminWallet;

    // Check if admin wallet is provided
    if (!adminWallet || typeof adminWallet !== "string") {
      return res.status(401).json({
        error:
          "Admin authentication required. Please provide adminWallet parameter.",
      });
    }

    // Get admin wallets from environment variable
    const adminWalletsEnv = process.env.ADMIN_WALLETS || "";

    // Parse comma-separated list of admin wallets
    const adminWallets = adminWalletsEnv
      .split(",")
      .map((w) => w.trim())
      .filter((w) => w.length > 0);

    if (adminWallets.includes(adminWallet)) {
      return next();
    }

    // If not a super-admin, check database for project access
    const projectId =
      (req.headers["x-project-id"] as string) ||
      req.body?.projectId ||
      req.query?.projectId;

    if (projectId) {
      const { getSupabaseClient } = require("../lib/supabaseClient");
      const supabase = getSupabaseClient();

      // Check user_project_access table using wallet_address
      // Note: This requires the middleware to be async, but Express middlewares can return promises.
      // However, to be safe with sync signature, we wrap it in a promise or use async middleware pattern.
      // Since we can't easily change signature to async here without ensuring express 5 or wrapper,
      // we will use the promise chain or assume express 5 (which handles async errors).
      // backend/package.json shows "express": "^5.1.0", so async middleware is supported!

      return (async () => {
        try {
          const { data: access } = await supabase
            .from("user_project_access")
            .select("role")
            .eq("project_id", projectId)
            .eq("wallet_address", adminWallet)
            .single();

          if (access && (access.role === "admin" || access.role === "owner")) {
            return next();
          }

          return res.status(403).json({
            error:
              "Access denied. This wallet is not authorized as an admin for this project.",
          });
        } catch (err) {
          console.error("Database check failed in auth middleware:", err);
          return res
            .status(500)
            .json({ error: "Internal authentication error" });
        }
      })();
    }

    if (!adminWalletsEnv) {
      console.error("⚠️  ADMIN_WALLETS environment variable not set!");
      return res.status(500).json({
        error:
          "Admin authentication not configured. Please set ADMIN_WALLETS environment variable.",
      });
    }

    return res.status(403).json({
      error: "Access denied. This wallet is not authorized as an admin.",
    });
  } catch (error) {
    console.error("Admin auth middleware error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Authentication error",
    });
  }
}

/**
 * Middleware to strictly enforce Project ID presence
 * Ensures that endpoints requiring project context cannot be called without it
 */
export function requireProject(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const projectId =
    (req.headers["x-project-id"] as string) ||
    req.body?.projectId ||
    req.query?.projectId;

  if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
    return res.status(400).json({
      error:
        "Project ID is required. Please provide it via headers (x-project-id), query, or body.",
    });
  }

  // Attach to request for easy access in controllers
  req.projectId = projectId;

  // Update body/query to ensure downstream controllers find it where they expect it
  // (though they should switch to using req.projectId)
  next();
}
