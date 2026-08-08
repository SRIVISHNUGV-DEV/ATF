import { resolveSqliteBinding, describeSqliteBinding } from "../src/core/native-sqlite";
import Database from "better-sqlite3";

console.log(describeSqliteBinding());
const nb = resolveSqliteBinding();
console.log("resolved:", nb);
const db = new Database(":memory:", nb ? { nativeBinding: nb } : {});
db.pragma("journal_mode = WAL");
console.log("query:", db.prepare("select 42 as v").get());
db.close();
console.log("OK");
