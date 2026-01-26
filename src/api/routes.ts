// Import controllers
import { Router } from "express";
import { PoolController } from "./poolController";
import { AdminController } from "./adminController";
import { UserVestingController } from "./userVestingController";
import { ConfigController } from "./configController";
import { AdminLogsController } from "./adminLogsController";
import { ClaimsController } from "./claimsController";
import { CronController } from "./cronController";
import { MetricsController } from "./metricsController";
import { SnapshotController } from "./snapshotController";
import { StreamController } from "./streamController";
import { TreasuryController } from "./treasuryController";
import { ProjectController } from "./projectController";
import { CreateProjectController } from "./createProjectController";
import { requireAdmin } from "../middleware/adminAuth";
import { claimRateLimiter } from "../middleware/rateLimiter";
import { deduplicationMiddleware } from "../middleware/deduplication";
import { validate, schemas } from "../middleware/validation";

const router = Router();
const poolController = new PoolController();
const adminController = new AdminController();
const userVestingController = new UserVestingController();
const configController = new ConfigController();
const adminLogsController = new AdminLogsController();
const claimsController = new ClaimsController();
const cronController = new CronController();
const metricsController = new MetricsController();
const snapshotController = new SnapshotController();
const streamController = new StreamController();
const treasuryController = new TreasuryController();
const projectController = new ProjectController();
const createProjectController = new CreateProjectController();

// Project routes
router.get("/projects", projectController.listProjects.bind(projectController));
router.get(
  "/projects/:id",
  projectController.getProjectDetails.bind(projectController)
);
router.put(
  "/projects/:id",
  requireAdmin,
  projectController.updateProject.bind(projectController)
);
router.post(
  "/projects",
  createProjectController.createProject.bind(createProjectController)
);

// Pool routes (SECURITY: Admin-protected write operations, read operations are public)
router.get(
  "/pools/get-creation-fee",
  poolController.getCreationFee.bind(poolController)
); // Public read - frontend needs this before admin auth
router.post(
  "/pools",
  requireAdmin,
  validate(schemas.createPool),
  poolController.createPool.bind(poolController)
);
router.post(
  "/pools/validate",
  requireAdmin,
  validate(schemas.createPool),
  poolController.validatePool.bind(poolController)
);
router.put("/pools/:id", requireAdmin, poolController.updatePool.bind(poolController));
router.put(
  "/pools/:id/allocations",
  requireAdmin,
  poolController.updateAllocations.bind(poolController)
);
router.put(
  "/pools/:id/rules/:ruleId",
  requireAdmin,
  poolController.updatePoolRule.bind(poolController)
);
router.get("/pools", poolController.listPools.bind(poolController)); // Public read
router.get("/pools/:id", poolController.getPoolDetails.bind(poolController)); // Public read
router.get(
  "/pools/:id/activity",
  poolController.getPoolActivity.bind(poolController)
); // Public read
router.get(
  "/pools/:id/users/:wallet",
  poolController.getUserStatus.bind(poolController)
); // Public read
router.get(
  "/pools/:id/streamflow-status",
  poolController.getStreamflowStatus.bind(poolController)
); // Public read
router.post("/pools/:id/rules", requireAdmin, poolController.addRule.bind(poolController));
router.post("/pools/:id/sync", requireAdmin, poolController.syncPool.bind(poolController));
router.delete("/pools/:id", requireAdmin, poolController.deletePool.bind(poolController));
router.patch(
  "/pools/:id/cancel",
  requireAdmin,
  poolController.cancelPool.bind(poolController)
);
router.put(
  "/pools/:id/details",
  requireAdmin,
  poolController.updatePoolDetails.bind(poolController)
);
router.post(
  "/pools/:id/snapshot",
  requireAdmin,
  poolController.triggerSnapshot.bind(poolController)
);
router.post(
  "/pools/:id/deploy-streamflow",
  requireAdmin,
  poolController.deployToStreamflow.bind(poolController)
);
router.post(
  "/pools/:id/cancel-streamflow",
  requireAdmin,
  poolController.cancelStreamflowPool.bind(poolController)
);
router.post("/pools/:id/topup", requireAdmin, poolController.topupPool.bind(poolController));

// Config routes
router.get(
  "/config/check-admin",
  configController.checkAdmin.bind(configController)
);
router.get(
  "/config/claim-policy",
  configController.getClaimPolicy.bind(configController)
);
router.put(
  "/config/claim-policy",
  requireAdmin,
  configController.updateClaimPolicy.bind(configController)
);
router.put("/config/mode", requireAdmin, configController.switchMode.bind(configController));

// User vesting routes
router.get(
  "/user/vesting/list",
  userVestingController.listUserVestings.bind(userVestingController)
);
router.get(
  "/user/vesting/summary",
  userVestingController.getVestingSummary.bind(userVestingController)
);
router.get(
  "/user/vesting/summary-all",
  userVestingController.getVestingSummaryAll.bind(userVestingController)
);
router.get(
  "/user/vesting/history",
  userVestingController.getClaimHistory.bind(userVestingController)
);
router.get(
  "/user/vesting/claim-history",
  userVestingController.getClaimHistory.bind(userVestingController)
);
router.get(
  "/user/vesting/claim-status/:signature",
  userVestingController.getClaimStatus.bind(userVestingController)
);

// Claim routes with rate limiting and deduplication
router.post(
  "/user/vesting/claim",
  claimRateLimiter,
  deduplicationMiddleware,
  validate(schemas.claimVesting),
  userVestingController.claimVesting.bind(userVestingController)
);
router.post(
  "/user/vesting/complete-claim",
  claimRateLimiter,
  deduplicationMiddleware,
  userVestingController.completeClaimWithFee.bind(userVestingController)
);

// V2 Split Transaction Claim Routes (eliminates Phantom "malicious dApp" warning)
// Step 1: Get fee-only transaction (user is sole signer)
router.post(
  "/user/vesting/claim-v2",
  claimRateLimiter,
  deduplicationMiddleware,
  validate(schemas.claimVesting),
  userVestingController.claimVestingV2.bind(userVestingController)
);
// Step 2: Verify fee payment and execute token transfer (backend sends)
router.post(
  "/user/vesting/execute-claim-v2",
  claimRateLimiter,
  userVestingController.executeClaimV2.bind(userVestingController)
);

// Admin logs routes
router.get(
  "/admin-logs",
  adminLogsController.getAdminLogs.bind(adminLogsController)
);
router.post(
  "/admin-logs",
  adminLogsController.createAdminLog.bind(adminLogsController)
);

// Claims routes
router.get("/claims", claimsController.listClaims.bind(claimsController));
router.get(
  "/claims/stats",
  claimsController.getClaimStats.bind(claimsController)
);
router.get(
  "/claims/:id",
  claimsController.getClaimDetails.bind(claimsController)
);
router.post(
  "/claims/:id/flag",
  requireAdmin,
  claimsController.flagClaim.bind(claimsController)
);
router.get(
  "/claims/wallet/:wallet",
  claimsController.getWalletClaims.bind(claimsController)
);

// Cron routes (SECURITY: Protected - only admin or cron service can trigger)
router.post(
  "/cron/snapshot",
  requireAdmin,
  cronController.triggerSnapshotCheck.bind(cronController)
);
router.post(
  "/cron/sync-dynamic",
  requireAdmin,
  cronController.triggerDynamicSync.bind(cronController)
);
router.get("/cron/health", cronController.healthCheck.bind(cronController)); // Public health check

// Metrics routes
router.get(
  "/metrics/dashboard",
  metricsController.getDashboardMetrics.bind(metricsController)
);
router.get(
  "/metrics/pool-balance",
  metricsController.getPoolBalanceEndpoint.bind(metricsController)
);
router.get(
  "/metrics/eligible-wallets",
  metricsController.getEligibleWalletsEndpoint.bind(metricsController)
);
router.get(
  "/metrics/activity-log",
  metricsController.getActivityLog.bind(metricsController)
);
router.get(
  "/metrics/claim-history-stats",
  metricsController.getClaimHistoryStats.bind(metricsController)
);
// Alias for frontend compatibility
router.get(
  "/metrics/claims-stats",
  metricsController.getClaimHistoryStats.bind(metricsController)
);

// Snapshot routes (SECURITY: Admin-protected)
router.get(
  "/snapshot/holders",
  requireAdmin,
  snapshotController.getHolders.bind(snapshotController)
);
router.post(
  "/snapshot/collection-stats",
  requireAdmin,
  snapshotController.getCollectionStats.bind(snapshotController)
);
router.post(
  "/snapshot/preview-rule",
  requireAdmin,
  snapshotController.previewRule.bind(snapshotController)
);
router.post(
  "/snapshot/calculate-summary",
  requireAdmin,
  snapshotController.calculateSummary.bind(snapshotController)
);
router.post(
  "/snapshot/process",
  requireAdmin,
  snapshotController.processSnapshot.bind(snapshotController)
);
router.post(
  "/snapshot/commit",
  requireAdmin,
  snapshotController.commitSnapshot.bind(snapshotController)
);

// Stream routes (SECURITY: Critical operations - Admin only)
router.post(
  "/stream/pause-all",
  requireAdmin,
  streamController.pauseAllStreams.bind(streamController)
);
router.post(
  "/stream/emergency-stop",
  requireAdmin,
  streamController.emergencyStopAllStreams.bind(streamController)
);
router.post(
  "/stream/resume-all",
  requireAdmin,
  streamController.resumeAllStreams.bind(streamController)
);

// Treasury routes
router.get(
  "/treasury/status",
  treasuryController.getTreasuryStatus.bind(treasuryController)
);
router.get(
  "/treasury/tokens",
  treasuryController.getTreasuryTokens.bind(treasuryController)
);
router.get(
  "/treasury/pools",
  treasuryController.getPoolBreakdown.bind(treasuryController)
);
router.get(
  "/treasury/available",
  treasuryController.getAvailableBalance.bind(treasuryController)
);
router.post(
  "/treasury/withdraw",
  requireAdmin,
  treasuryController.withdrawTokens.bind(treasuryController)
);
router.post(
  "/treasury/withdraw-sol",
  requireAdmin,
  treasuryController.withdrawSol.bind(treasuryController)
);

// Admin routes (SECURITY: All admin operations protected)
router.get(
  "/admin/dashboard-batch",
  adminController.getDashboardBatch.bind(adminController)
);
router.get(
  "/admin/pool/:poolId/members",
  requireAdmin,
  adminController.getPoolMembers.bind(adminController)
);
router.patch(
  "/admin/pool/:poolId/member/:wallet",
  requireAdmin,
  adminController.updatePoolMember.bind(adminController)
);
router.patch(
  "/admin/pool/:poolId/state",
  requireAdmin,
  adminController.updatePoolState.bind(adminController)
);

export default router;
