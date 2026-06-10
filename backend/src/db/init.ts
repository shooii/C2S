import { databasePath, ensureStorageDirs } from "../config/paths";
import { getDb } from "./database";

ensureStorageDirs();
getDb();

console.log(`C2S database initialized at ${databasePath}`);

