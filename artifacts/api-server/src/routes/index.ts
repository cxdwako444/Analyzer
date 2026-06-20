import { Router, type IRouter } from "express";
import healthRouter from "./health";
import twitchRouter from "./twitch";
import kickRouter from "./kick";

const router: IRouter = Router();

router.use(healthRouter);
router.use(twitchRouter);
router.use(kickRouter);

export default router;
