import "dotenv/config";
import { app } from "./app.js";
import { config } from "./config.js";

app.listen(config.port, () => {
  console.log(`Safe Delete backend listening on http://localhost:${config.port}`);
  console.log(`Salesforce org alias: ${config.orgAlias}`);
});
