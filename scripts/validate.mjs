#!/usr/bin/env node
/**
 * 校验 plugins.json / delisted.json。
 *
 * 分两段跑：
 *   1. 离线检查 —— schema、id 重复、排序、下架名单交叉；不联网，永远能跑。
 *   2. 联网检查 —— 仓库是否公开、LICENSE 是否真的存在且与声明一致、
 *      reviewedCommit 是否真的存在、lockedVersion 那个 tag 是否真的存在、
 *      author 和 repo owner 是否同一个账号。
 *
 * CI 里两段都跑；本地 `node scripts/validate.mjs --offline` 只跑第一段。
 *
 * 为什么不用 ajv：这个仓库唯一的产物是两份 JSON，为它装一棵依赖树不值当。
 * schema/*.json 是给编辑器做补全和给人读的，真正拦 PR 的是这个文件。
 * **两边都改**：改了 schema 就回来改这里，反过来也一样。
 *
 * 这个脚本只能拦机械的东西。它拦不住「代码在偷数据」——
 * 那一关只有人能过，见 README 的「审核看什么」。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = process.argv.includes("--offline");

/** GitHub API 的鉴权头。CI 里有 GITHUB_TOKEN（只读就够），本地没有也能跑，只是限 60 次/小时。 */
const GH_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "uranus-plugins-validate",
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

const problems = [];
/** @param {string} where 出问题的位置，写成人能定位的样子（如 `plugins[3] weather-card`） */
const fail = (where, msg) => problems.push(`${where}：${msg}`);

// ── schema 的几条规则，和 schema/*.json 保持一致 ──────────────────────

const RE = {
  id: /^[a-z][a-z0-9-]{2,63}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  sha: /^[0-9a-f]{40}$/,
  tag: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  authorUrl: /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/?$/,
  repoUrl: /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/,
};

/** OSI 认证的协议。要加新的先确认它在 https://opensource.org/licenses 上。 */
const LICENSES = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0",
  "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later",
  "AGPL-3.0-only", "AGPL-3.0-or-later", "Unlicense", "0BSD",
]);

/**
 * 禁用的协议，报错时给出所以然。
 *
 * CC-BY-NC 这类「禁止商用」的授权**不是**开源协议 —— 它违反开源定义第 6 条
 * （不得歧视使用领域）。本目录确实不收含付费内容的插件，但那是**目录的准入规则**，
 * 靠人工审核和下架执行，不靠作者的协议。两件事别混在一起，见 README。
 */
const REJECTED = {
  "CC-BY-NC-4.0": "「禁止商用」不是开源协议。本目录要求 OSI 协议；不收付费插件是目录的准入规则，不靠协议限制",
  "CC-BY-NC-SA-4.0": "同上",
  "CC-BY-ND-4.0": "「禁止改作」不是开源协议",
  "CC-BY-4.0": "CC 协议是给作品不是给代码的，请用 MIT / Apache-2.0 这类软件协议",
  "CC0-1.0": "请用 Unlicense 或 0BSD，CC0 对专利和代码的表述不清楚",
  "SSPL-1.0": "SSPL 不是 OSI 认证的开源协议",
  "BUSL-1.1": "BUSL 不是开源协议，它有商用限制和时间锁",
  "Elastic-2.0": "Elastic License 不是 OSI 认证的开源协议",
  "UNLICENSED": "这个值的意思是「没有授权」。要放弃版权请用 Unlicense（少一个 D）",
  "Proprietary": "本目录只收开源插件",
};

const TAGS = new Set(["界面", "主题", "聊天增强", "角色", "世界书", "预设", "工具", "数据", "实验性"]);

const ENTRY_KEYS = new Set([
  "id", "title", "desc", "author", "repo", "license", "tags",
  "homepage", "lockedVersion", "reviewedAt", "reviewedCommit", "addedAt",
]);
const ENTRY_REQUIRED = ["id", "title", "desc", "author", "repo", "license", "reviewedAt", "reviewedCommit"];

// ── 读文件 ───────────────────────────────────────────────────────────

function readJson(rel) {
  const file = path.join(ROOT, rel);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(rel, `读不出来或不是合法 JSON —— ${err.message}`);
    return null;
  }
}

function isDate(v) {
  if (typeof v !== "string" || !RE.date.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  // 2026-02-30 过得了正则过不了这里
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// ── 第一段：离线检查 ─────────────────────────────────────────────────

/** @returns {Array<{entry: object, owner: string, repo: string}>} 过了离线检查、可以联网核的条目 */
function checkIndex(index) {
  if (!index || typeof index !== "object") return [];

  if (index.version !== 1) fail("plugins.json", `version 必须是 1，现在是 ${JSON.stringify(index.version)}`);
  if (!isDate(index.updatedAt)) fail("plugins.json", "updatedAt 必须是 YYYY-MM-DD 的真实日期");
  if (!Array.isArray(index.plugins)) {
    fail("plugins.json", "plugins 必须是数组");
    return [];
  }

  const seenId = new Map();
  const seenRepo = new Map();
  const checkable = [];

  index.plugins.forEach((e, i) => {
    const at = `plugins[${i}]${e?.id ? ` ${e.id}` : ""}`;

    if (!e || typeof e !== "object" || Array.isArray(e)) {
      fail(at, "条目必须是对象");
      return;
    }

    for (const k of ENTRY_REQUIRED) {
      if (!(k in e)) fail(at, `缺字段 ${k}`);
    }
    for (const k of Object.keys(e)) {
      if (!ENTRY_KEYS.has(k)) fail(at, `多了个不认识的字段 ${k}`);
    }

    // id
    if (typeof e.id === "string") {
      if (!RE.id.test(e.id)) {
        fail(at, `id「${e.id}」不合规：小写字母开头，只能有小写字母、数字和连字符，3~64 字`);
      } else if (seenId.has(e.id)) {
        fail(at, `id 和 plugins[${seenId.get(e.id)}] 撞了。id 必须唯一`);
      } else {
        seenId.set(e.id, i);
      }
    }

    // title / desc
    if (typeof e.title !== "string" || !e.title.trim() || e.title.length > 40) {
      fail(at, "title 必须是 1~40 字的非空字符串");
    }
    if (typeof e.desc !== "string" || e.desc.trim().length < 10 || e.desc.length > 200) {
      fail(at, "desc 必须是 10~200 字 —— 太短说不清楚，太长卡片放不下");
    }

    // author / repo
    const am = typeof e.author === "string" ? e.author.match(RE.authorUrl) : null;
    if (!am) fail(at, "author 必须是 GitHub 主页链接，形如 https://github.com/someone");

    const rm = typeof e.repo === "string" ? e.repo.match(RE.repoUrl) : null;
    if (!rm) {
      fail(at, "repo 必须是 GitHub 仓库链接，形如 https://github.com/someone/my-plugin（不要带 .git、分支路径或结尾斜杠）");
    } else if (/\.git$/i.test(rm[2])) {
      // clone 地址而不是网页地址。用户点卡片会跳到一个 404
      fail(at, `repo 不要带 .git 后缀 —— 那是 clone 地址。填网页地址：https://github.com/${rm[1]}/${rm[2].replace(/\.git$/i, "")}`);
    } else if (seenRepo.has(e.repo.toLowerCase())) {
      fail(at, `repo 和 plugins[${seenRepo.get(e.repo.toLowerCase())}] 是同一个。一个仓库只能上架一条`);
    } else {
      seenRepo.set(e.repo.toLowerCase(), i);
    }

    // author 和 repo owner 必须同一个账号 —— 否则是在上架别人的插件
    if (am && rm && am[1].toLowerCase() !== rm[1].toLowerCase()) {
      fail(at, `author 是 ${am[1]}，但 repo 的 owner 是 ${rm[1]} —— 不是同一个账号。你在上架别人的插件吗？`);
    }

    // license
    if (typeof e.license !== "string") {
      fail(at, "缺 license");
    } else if (REJECTED[e.license]) {
      fail(at, `license「${e.license}」不行：${REJECTED[e.license]}`);
    } else if (!LICENSES.has(e.license)) {
      fail(at, `license「${e.license}」不在允许的清单里。必须是 OSI 认证协议的 SPDX 标识符，如 MIT、Apache-2.0、GPL-3.0-only`);
    }

    // tags
    if ("tags" in e) {
      if (!Array.isArray(e.tags) || e.tags.length > 5) {
        fail(at, "tags 必须是数组，最多 5 个");
      } else {
        if (new Set(e.tags).size !== e.tags.length) fail(at, "tags 里有重复");
        for (const t of e.tags) {
          if (!TAGS.has(t)) fail(at, `标签「${t}」不认识。可用：${[...TAGS].join(" / ")}`);
        }
      }
    }

    if ("homepage" in e && (typeof e.homepage !== "string" || !e.homepage.startsWith("https://"))) {
      fail(at, "homepage 必须是 https:// 开头的链接");
    }
    if ("lockedVersion" in e && (typeof e.lockedVersion !== "string" || !RE.tag.test(e.lockedVersion))) {
      fail(at, "lockedVersion 必须是一个 git tag 名，如 v1.2.0");
    }

    // 审核信息
    if (!isDate(e.reviewedAt)) {
      fail(at, "reviewedAt 必须是 YYYY-MM-DD 的真实日期");
    } else if (e.reviewedAt > new Date().toISOString().slice(0, 10)) {
      fail(at, `reviewedAt 是未来的日期（${e.reviewedAt}）`);
    }
    if (typeof e.reviewedCommit !== "string" || !RE.sha.test(e.reviewedCommit)) {
      fail(at, "reviewedCommit 必须是完整的 40 位 commit SHA（不是 7 位简写）");
    }
    if ("addedAt" in e && !isDate(e.addedAt)) {
      fail(at, "addedAt 必须是 YYYY-MM-DD 的真实日期");
    }
    if (isDate(e.addedAt) && isDate(e.reviewedAt) && e.reviewedAt < e.addedAt) {
      fail(at, `reviewedAt（${e.reviewedAt}）早于 addedAt（${e.addedAt}）`);
    }

    if (rm && typeof e.id === "string" && RE.id.test(e.id)) {
      checkable.push({ entry: e, owner: rm[1], repo: rm[2] });
    }
  });

  // 按 id 排序 —— 不然条目多了之后，每个 PR 都在文件末尾加行，冲突不断
  const ids = index.plugins.map((e) => e?.id).filter((v) => typeof v === "string");
  const sorted = [...ids].sort();
  if (ids.join("\0") !== sorted.join("\0")) {
    fail("plugins.json", `条目要按 id 字母序排。跑一下 \`node scripts/sort.mjs\` 自动排好`);
  }

  return checkable;
}

function checkDelisted(delisted, index) {
  if (!delisted || typeof delisted !== "object") return;

  if (delisted.version !== 1) fail("delisted.json", "version 必须是 1");
  if (!isDate(delisted.updatedAt)) fail("delisted.json", "updatedAt 必须是 YYYY-MM-DD 的真实日期");
  if (!Array.isArray(delisted.plugins)) {
    fail("delisted.json", "plugins 必须是数组");
    return;
  }

  const REASONS = new Set(["security", "paid-content", "license", "author-request", "repo-gone", "broken", "other"]);
  const live = new Set((index?.plugins ?? []).map((e) => e?.id).filter(Boolean));
  const seen = new Set();

  delisted.plugins.forEach((e, i) => {
    const at = `delisted[${i}]${e?.id ? ` ${e.id}` : ""}`;

    if (!e || typeof e !== "object") {
      fail(at, "条目必须是对象");
      return;
    }
    if (typeof e.id !== "string" || !RE.id.test(e.id)) {
      fail(at, "id 不合规");
    } else {
      if (seen.has(e.id)) fail(at, "id 在下架名单里重复了");
      seen.add(e.id);
      // 这一条是整个校验里最要紧的：同一个 id 同时在售又在下架名单里，
      // 客户端两边都读得到，用户会看见「这个插件可以装」和「这个插件有安全问题」同时出现
      if (live.has(e.id)) {
        fail(at, `id「${e.id}」同时出现在 plugins.json 里。下架的条目必须从 plugins.json 删掉`);
      }
    }
    if (typeof e.title !== "string" || !e.title.trim() || e.title.length > 40) {
      fail(at, "title 必须是 1~40 字的非空字符串");
    }
    if (!isDate(e.delistedAt)) fail(at, "delistedAt 必须是 YYYY-MM-DD 的真实日期");
    if (!REASONS.has(e.reason)) fail(at, `reason 必须是：${[...REASONS].join(" / ")}`);
    if (e.reason === "security" && (typeof e.note !== "string" || !e.note.trim())) {
      fail(at, "reason 是 security 的话必须写 note —— 用户要靠它判断该不该立刻卸载");
    }
    if ("note" in e && (typeof e.note !== "string" || e.note.length > 200)) {
      fail(at, "note 最多 200 字");
    }
    if ("repo" in e && (typeof e.repo !== "string" || !e.repo.startsWith("https://github.com/"))) {
      fail(at, "repo 必须是 GitHub 链接，仓库已消失就整个字段不写");
    }
    for (const k of Object.keys(e)) {
      if (!["id", "title", "repo", "delistedAt", "reason", "note"].includes(k)) {
        fail(at, `多了个不认识的字段 ${k}`);
      }
    }
  });
}

// ── 第二段：联网检查 ─────────────────────────────────────────────────

async function gh(url) {
  const res = await fetch(url, { headers: GH_HEADERS });
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("GitHub API 限流了。CI 里会带 GITHUB_TOKEN，本地跑加 --offline 跳过联网检查");
  }
  return res;
}

async function checkOnline(checkable) {
  for (const { entry, owner, repo } of checkable) {
    const at = `plugins ${entry.id}`;
    const slug = `${owner}/${repo}`;

    let meta;
    try {
      const res = await gh(`https://api.github.com/repos/${slug}`);
      if (res.status === 404) {
        fail(at, `仓库 ${slug} 访问不到 —— 不存在、是私有的、或者改名了。插件仓库必须公开`);
        continue;
      }
      if (!res.ok) {
        fail(at, `查仓库 ${slug} 时 GitHub 返回 ${res.status}`);
        continue;
      }
      meta = await res.json();
    } catch (err) {
      fail(at, `查仓库 ${slug} 失败：${err.message}`);
      continue;
    }

    if (meta.private) fail(at, `仓库 ${slug} 是私有的，用户点进去打不开`);
    if (meta.archived) fail(at, `仓库 ${slug} 已归档（作者已停止维护）`);

    // 改名/转移过的仓库：GitHub 会跟随重定向，但用户收藏的链接迟早会断
    const full = String(meta.full_name ?? "");
    if (full.toLowerCase() !== slug.toLowerCase()) {
      fail(at, `仓库已经从 ${slug} 转移到 ${full}，请把 repo 和 author 改成新地址`);
    }

    // LICENSE 必须真的存在，且和声明的一致
    try {
      const res = await gh(`https://api.github.com/repos/${slug}/license`);
      if (res.status === 404) {
        fail(at, `仓库根目录没有 LICENSE 文件。声明了 ${entry.license} 就要把协议正文放进去`);
      } else if (res.ok) {
        const spdx = (await res.json())?.license?.spdx_id;
        if (spdx && spdx !== "NOASSERTION" && spdx !== entry.license) {
          fail(at, `索引里写的是 ${entry.license}，但仓库里的 LICENSE 是 ${spdx}`);
        } else if (spdx === "NOASSERTION") {
          fail(at, "GitHub 认不出仓库里的 LICENSE 是哪个协议 —— 多半是改过正文。请放一份未经改动的协议原文");
        }
      }
    } catch (err) {
      fail(at, `查 ${slug} 的 LICENSE 失败：${err.message}`);
    }

    // reviewedCommit 得真的在这个仓库里 —— 防止随手编一个 40 位十六进制
    if (RE.sha.test(entry.reviewedCommit ?? "")) {
      try {
        const res = await gh(`https://api.github.com/repos/${slug}/commits/${entry.reviewedCommit}`);
        if (res.status === 404 || res.status === 422) {
          fail(at, `reviewedCommit ${entry.reviewedCommit.slice(0, 10)}… 在 ${slug} 里找不到`);
        }
      } catch (err) {
        fail(at, `查 commit 失败：${err.message}`);
      }
    }

    // lockedVersion 那个 tag 也得真的存在
    if (entry.lockedVersion) {
      try {
        const res = await gh(`https://api.github.com/repos/${slug}/git/ref/tags/${encodeURIComponent(entry.lockedVersion)}`);
        if (res.status === 404) {
          fail(at, `lockedVersion 写的 tag「${entry.lockedVersion}」在 ${slug} 里不存在。先在仓库里打 tag 发 release`);
        }
      } catch (err) {
        fail(at, `查 tag 失败：${err.message}`);
      }
    }
  }
}

// ── 跑 ───────────────────────────────────────────────────────────────

const index = readJson("plugins.json");
const delisted = readJson("delisted.json");

const checkable = checkIndex(index);
checkDelisted(delisted, index);

// 离线这一段有问题就别联网了 —— 省得在一堆格式错误里找真问题
if (problems.length === 0 && !OFFLINE && checkable.length > 0) {
  await checkOnline(checkable);
}

if (problems.length > 0) {
  console.error(`\n校验没过，${problems.length} 个问题：\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("\n改好之后往这个 PR 再推一次就会重新跑。\n");
  process.exit(1);
}

const n = index?.plugins?.length ?? 0;
const d = delisted?.plugins?.length ?? 0;
console.log(`校验通过：${n} 个在售插件，${d} 个已下架${OFFLINE ? "（跳过了联网检查）" : ""}`);
