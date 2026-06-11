import fs from "node:fs";
import path from "node:path";

export const backendRoot = path.resolve(__dirname, "../..");
export const storageRoot = path.join(backendRoot, "storage");
export const templateStorageDir = path.join(storageRoot, "templates");
export const templatePackageStorageDir = path.join(storageRoot, "template-packages");
export const inputStorageDir = path.join(storageRoot, "input");
export const outputStorageDir = path.join(storageRoot, "outputs");
export const logStorageDir = path.join(storageRoot, "logs");
export const dataStorageDir = path.join(storageRoot, "data");
export const databasePath = path.join(dataStorageDir, "c2s.sqlite");

export const fmeCandidates = [
  "fme.exe",
  "C:\\Program Files\\FME\\fme.exe"
];

export function ensureStorageDirs(): void {
  [
    storageRoot,
    templateStorageDir,
    templatePackageStorageDir,
    inputStorageDir,
    outputStorageDir,
    logStorageDir,
    dataStorageDir
  ].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
}
