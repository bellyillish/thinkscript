#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs-extra");

function normalizeSlashes(p) {
  return p.replace(/\\/g, "/");
}

async function readTextCached(fileAbs, rawCache) {
  if (rawCache.has(fileAbs)) return rawCache.get(fileAbs);
  const txt = await fs.readFile(fileAbs, "utf8");
  rawCache.set(fileAbs, txt);
  return txt;
}

async function expandIncludes({
  filePath,
  projectRoot,
  includeRe,
  seenStack,
  rawCache,
  includedOnceSet
}) {
  const absPath = path.resolve(filePath);

  // cycle detection (true cycles are always an error)
  if (seenStack.includes(absPath)) {
    const cycle = [...seenStack, absPath].map((p) =>
      normalizeSlashes(path.relative(projectRoot, p))
    );
    throw new Error(`Include cycle detected:\n  ${cycle.join("\n  -> ")}`);
  }

  const text      = await readTextCached(absPath, rawCache);
  const baseDir   = path.dirname(absPath);
  const nextStack = [...seenStack, absPath];

  let out = "";
  let lastIndex = 0;

  includeRe.lastIndex = 0;
  let match;

  while ((match = includeRe.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = includeRe.lastIndex;

    // text before include directive
    out += text.slice(lastIndex, matchStart);

    const directive = (match[1] || "").trim();
    const rawIncludePath = (match[2] || "").trim();

    if (!rawIncludePath) {
      throw new Error(`Malformed include in ${absPath} at index ${matchStart}`);
    }

    const isOnce =
      directive.includes("include_once") || directive.includes("@include_once");

    const resolved = path.resolve(baseDir, rawIncludePath);
    const relFromRoot = normalizeSlashes(
      path.relative(projectRoot, resolved)
    );

    if (isOnce) {
      if (includedOnceSet.has(resolved)) {
        lastIndex = matchEnd;
        continue;
      }
      includedOnceSet.add(resolved);
    }

    const included = await expandIncludes({
      filePath: resolved,
      projectRoot,
      includeRe,
      seenStack: nextStack,
      rawCache,
      includedOnceSet
    });

    out += included;
    lastIndex = matchEnd;
  }

  // remaining tail after last include
  out += text.slice(lastIndex);
  return out;
}

async function listEntryFilesRecursive(entryDirAbs, extensions) {
  const out = [];

  async function walk(dirAbs) {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (extensions.includes(ext)) out.push(p);
    }
  }

  await walk(entryDirAbs);
  return out;
}

async function buildOnce(config) {
  const projectRoot = process.cwd();
  const entryDirAbs = path.resolve(projectRoot, config.entryDir);
  const distDirAbs  = path.resolve(projectRoot, config.distDir);

  if (!distDirAbs.startsWith(projectRoot) || distDirAbs === projectRoot || distDirAbs.startsWith(entryDirAbs)) {
    console.warn(`[build] Unsafe dist folder detected.`);
    await fs.ensureDir(distDirAbs);
  }
  else {
    await fs.emptyDir(distDirAbs);
  }

  const includeRe = new RegExp(config.includeRegex, "gm");

  // caches / state
  const rawCache = new Map();

  const entryFiles = await listEntryFilesRecursive(entryDirAbs, config.extensions);

  if (entryFiles.length === 0) {
    console.log(`[build] No entry files found in ${config.entryDir}`);
    return;
  }

  let builtCount = 0;

  for (const entryAbs of entryFiles) {
    // include_once should be per compiled output, so reset per entry file
    const includedOnceSet = new Set();

    // (Optional) If you want the entry file itself to count as "already included once"
    // includedOnceSet.add(entryAbs);

    const relEntry = path.relative(entryDirAbs, entryAbs);
    const outAbs = path.join(distDirAbs, relEntry);

    let expanded = await expandIncludes({
      filePath: entryAbs,
      projectRoot,
      includeRe,
      seenStack: [],
      rawCache,
      includedOnceSet
    });

    if (config.tokens) {
      for (const [name, value] of Object.entries(config.tokens)) {
        expanded = expanded.replaceAll(`"{{${name}}}"`, value);
      }
    }

    if (config.minify) {
      expanded = expanded.replaceAll(/#.*/g, "").replaceAll(/(\r|\n|\s){1,}/g, " ");
    }
    else {
      expanded = expanded.replaceAll(/(\r|\n){3,}/g, "\n\n");
    }

    expanded = expanded.trim();

    const banner = (config.banner || "")
      .replaceAll("{{TIMESTAMP}}", new Date().toISOString())
      .replaceAll("{{SOURCE}}", normalizeSlashes(path.relative(projectRoot, entryAbs))
    );

    await fs.ensureDir(path.dirname(outAbs));
    await fs.writeFile(outAbs, banner + expanded, "utf8");

    builtCount++;
    console.log(`[build] ${normalizeSlashes(path.relative(projectRoot, outAbs))}`);
  }

  console.log(`[build] Done. Built ${builtCount} file(s).`);
}

async function main() {
  const projectRoot = process.cwd();
  const cfgPath = path.resolve(projectRoot, "build.config.json");

  if (!(await fs.pathExists(cfgPath))) {
    console.error(`[build] Missing build.config.json at ${cfgPath}`);
    process.exit(1);
  }

  const config = await fs.readJson(cfgPath);

  // defaults
  config.entryDir     ||= "src";
  config.distDir      ||= "dist";
  config.extensions   ||= [".ts", ".thinkscript", ".txt"];
  config.includeRegex ||= "(?:^|\\s)(#include|include|//\\s*@include)\\s+\"?([^\";\\r\\n]+)\"?;?";

  try {
    await buildOnce(config);
  } catch (err) {
    console.error(`[build] ERROR: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

main();
