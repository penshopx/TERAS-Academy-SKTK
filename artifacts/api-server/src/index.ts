import app from "./app";
import { logger } from "./lib/logger";
import { startTrainerFollowUpReminderScheduler } from "./lib/trainer-follow-up-notifications";
import { initializeReadinessExportTrendRetentionMonitoring, startReadinessExportTrendRetentionScheduler } from "./lib/readiness-export-trend-retention";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startTrainerFollowUpReminderScheduler();
  if (process.env.NODE_ENV !== "test") {
    void initializeReadinessExportTrendRetentionMonitoring()
      .then(() => startReadinessExportTrendRetentionScheduler())
      .catch(err => {
        logger.error({ err }, "Could not initialize readiness retention monitoring");
        process.exit(1);
      });
  }
});
