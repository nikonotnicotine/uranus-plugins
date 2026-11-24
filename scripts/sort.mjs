#!/usr/bin/env node
/**
 * 把 plugins.json / delisted.json 按 id 排好序、补上 addedAt、刷新 updatedAt。
 *
 * 排序是为了减少 PR 冲突：条目多了以后，所有人都往文件末尾加行的话，
 * 两个同时开的 PR 必定撞在一起。按 id 排开之后撞的概率低得多。
 *
 * `--check` 只报告不改文件（CI 用），不加就直接写回去。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
const TODAY = new Date().toISOString().slice(0, 10);

let changed = false;

for (const name of ["plugins.json", "delisted.json"]) {
  const file = path.join(ROOT, name);
  const before = fs.readFileSync(file, "utf8");
  const data = JSON.parse(before);

  if (Array.isArray(data.plugins)) {
    data.plugins.sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? ""), "en"));

    // 新条目补 addedAt。已经有的不动 —— 那是首次收录日期，不该随每次改信息变。
    if (name === "plugins.json") {
      for (const e of data.plugins) {
        if (e && typeof e === "object" && !e.addedAt) e.addedAt = e.reviewedAt ?? TODAY;
      }
    }
  }

  // 字段按固定顺序写，diff 才看得懂
  const ORDER = [
    "id", "title", "desc", "author", "repo", "license", "tags", "homepage",
    "lockedVersion", "reviewedAt", "reviewedCommit", "addedAt",
    "delistedAt", "reason", "note",
  ];
  if (Array.isArray(data.plugins)) {
    data.plugins = data.plugins.map((e) => {
      if (!e || typeof e !== "object") return e;
      const out = {};
      for (const k of ORDER) if (k in e) out[k] = e[k];
      for (const k of Object.keys(e)) if (!(k in out)) out[k] = e[k]; // 不认识的字段也别丢，交给 validate 去报
      return out;
    });
  }

  // updatedAt 只在内容真的变了的时候才改 —— 否则每次跑脚本都产生一个无意义的 diff
  const withoutDate = (o) => JSON.stringify({ ...o, updatedAt: "" });
  if (withoutDate(data) !== withoutDate(JSON.parse(before))) data.updatedAt = TODAY;

  const after = `${JSON.stringify(data, null, 2)}\n`;
  if (after !== before) {
    changed = true;
    if (CHECK) {
      console.error(`✗ ${name} 没排好序或缺字段。本地跑一下 \`node scripts/sort.mjs\` 再提交。`);
    } else {
      fs.writeFileSync(file, after);
      console.log(`已整理 ${name}`);
    }
  }
}

if (CHECK && changed) process.exit(1);
if (!changed) console.log("已经是整理好的样子，没动。");
