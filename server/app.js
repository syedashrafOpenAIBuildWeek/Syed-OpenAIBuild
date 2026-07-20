import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { AppError, errorBody } from "./errors.js";
import { parseIntent } from "./openai.js";
import { buildPlan } from "./planner.js";
import { approve, rollback } from "./executor.js";
import { statusForRun } from "./store.js";

export const app = express();
app.disable("x-powered-by");
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin))
        return callback(null, true);
      callback(new AppError("Origin is not allowed", 403));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-Backend-Token", "X-Approval-Token"]
  })
);
app.use(express.json({ limit: "32kb" }));
app.use((req, _res, next) => {
  if (config.apiToken && req.get("X-Backend-Token") !== config.apiToken) {
    return next(new AppError("Invalid backend API token", 401));
  }
  next();
});

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, orgAlias: config.orgAlias })
);

app.post("/api/plan", async (req, res, next) => {
  try {
    const command = String(req.body?.command || "").trim();
    if (!command || command.length > 1000)
      throw new AppError("Command must be 1-1000 characters");
    const intent = await parseIntent(command);
    res.json(await buildPlan(command, intent));
  } catch (error) {
    next(error);
  }
});

app.post("/api/runs/:id/approve", async (req, res, next) => {
  try {
    if (req.body?.confirmed !== true)
      throw new AppError("Explicit confirmation is required");
    const execution = approve(req.params.id, req.body.approvalToken);
    res.status(202).json({ status: "executing" });
    execution.catch((error) => console.error(error));
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:id", (req, res, next) => {
  try {
    res.json(statusForRun(req.params.id, req.get("X-Approval-Token") || ""));
  } catch (error) {
    next(error);
  }
});

app.post("/api/runs/:id/rollback", async (req, res, next) => {
  try {
    if (req.body?.confirmed !== true)
      throw new AppError("Explicit rollback confirmation is required");
    res.json(await rollback(req.params.id, req.body.approvalToken));
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json(errorBody(error));
});
