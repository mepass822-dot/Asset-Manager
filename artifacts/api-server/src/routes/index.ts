import { Router, type IRouter } from "express";
import healthRouter from "./health";
import walletsRouter from "./wallets";
import agentRouter from "./agent";
import rulesRouter from "./rules";

const router: IRouter = Router();

router.use(healthRouter);
router.use(walletsRouter);
router.use(agentRouter);
router.use(rulesRouter);

export default router;
