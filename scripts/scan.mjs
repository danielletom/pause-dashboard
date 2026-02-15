#!/usr/bin/env node
/**
 * Pause Project Dashboard Scanner
 * Reads pause-app and pause-api repos, outputs dashboard-data.json
 * Zero dependencies — uses only Node.js built-ins
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'fs';
import { join, basename, relative } from 'path';
import { execSync } from 'child_process';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
};

const APP_PATH = getArg('app-path') || '../pause-app';
const API_PATH = getArg('api-path') || '../pause-api';
const OUTPUT = getArg('output') || 'dashboard-data.json';
const OVERRIDES_PATH = join(import.meta.dirname || '.', '..', 'manual-overrides.json');

// ─── Helpers ───────────────────────────────────────────────

function readFile(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

function globDir(dir, pattern, opts = {}) {
  const results = [];
  if (!existsSync(dir)) return results;
  const skipDirs = opts.skipDirs || ['node_modules', '.next', 'dist', '.expo', '.git'];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skipDirs.includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...globDir(full, pattern, opts));
      } else if (entry.name.match(pattern)) {
        results.push(full);
      }
    }
  } catch { /* permission denied etc */ }
  return results;
}

function gitInfo(repoPath) {
  try {
    const sha = execSync('git log -1 --format=%h', { cwd: repoPath, encoding: 'utf-8' }).trim();
    const message = execSync('git log -1 --format=%s', { cwd: repoPath, encoding: 'utf-8' }).trim();
    const date = execSync('git log -1 --format=%ci', { cwd: repoPath, encoding: 'utf-8' }).trim();
    return { sha, message, date };
  } catch {
    return { sha: 'unknown', message: 'unknown', date: new Date().toISOString() };
  }
}

// ─── 1. Scan App Screens ───────────────────────────────────

function scanScreens() {
  const dirs = [
    join(APP_PATH, 'app', '(app)'),
    join(APP_PATH, 'app', '(auth)'),
    join(APP_PATH, 'app', '(onboarding)'),
  ];

  const screens = [];
  for (const dir of dirs) {
    const files = globDir(dir, /\.tsx$/);
    for (const f of files) {
      const name = basename(f);
      if (name === '_layout.tsx' || name === '+not-found.tsx') continue;
      const section = basename(join(f, '..'));
      screens.push({ name, section, path: relative(APP_PATH, f) });
    }
  }

  // Parse layout for declared-but-missing screens
  const layoutPath = join(APP_PATH, 'app', '(app)', '_layout.tsx');
  const layoutContent = readFile(layoutPath);
  // Only match Tabs.Screen name="..." — not TabBarIcon name="..." or other components
  const declaredRoutes = [...layoutContent.matchAll(/Tabs\.Screen[\s\S]*?name="([^"]+)"/g)].map(m => m[1]);
  const existingNames = new Set(screens.filter(s => s.section === '(app)').map(s => s.name.replace('.tsx', '')));
  const missingScreens = declaredRoutes.filter(r => !existingNames.has(r) && r !== 'index');

  return { screens, missingScreens, total: screens.length, declared: declaredRoutes.length };
}

// ─── 2. Scan API Endpoints ─────────────────────────────────

function scanEndpoints() {
  const routeFiles = globDir(join(API_PATH, 'src', 'app', 'api'), /route\.ts$/);
  const endpoints = [];
  const methods = { GET: 0, POST: 0, PUT: 0, DELETE: 0, PATCH: 0 };

  for (const f of routeFiles) {
    const content = readFile(f);
    const path = '/' + relative(join(API_PATH, 'src', 'app'), f)
      .replace(/\/route\.ts$/, '')
      .replace(/\\/g, '/');

    const fileMethods = [];
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      if (content.match(new RegExp(`export\\s+(async\\s+)?function\\s+${method}`))) {
        fileMethods.push(method);
        methods[method]++;
      }
    }

    if (fileMethods.length > 0) {
      endpoints.push({ path, methods: fileMethods });
    }
  }

  return { endpoints, methods, total: endpoints.length };
}

// ─── 3. Scan Screen↔API Connectivity ──────────────────────

function scanConnectivity(screens) {
  const map = [];
  for (const screen of screens) {
    const fullPath = join(APP_PATH, screen.path);
    const content = readFile(fullPath);
    // Match apiRequest('/api/...', or apiRequest("/api/..."
    const calls = [...content.matchAll(/apiRequest\s*\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
    // Also match fetch calls to API
    const fetchCalls = [...content.matchAll(/fetch\s*\(\s*['"`]([^'"`]*\/api\/[^'"`]+)['"`]/g)].map(m => m[1]);
    const allCalls = [...new Set([...calls, ...fetchCalls])];
    if (allCalls.length > 0) {
      map.push({ screen: screen.name, calls: allCalls });
    }
  }
  return map;
}

// ─── 4. Check Infrastructure ──────────────────────────────

function scanInfra() {
  const checks = {};

  // Tests
  const appTests = globDir(APP_PATH, /\.(test|spec)\.(ts|tsx|js)$/);
  const apiTests = globDir(API_PATH, /\.(test|spec)\.(ts|tsx|js)$/);
  checks.hasAppTests = appTests.length > 0;
  checks.hasApiTests = apiTests.length > 0;
  checks.appTestCount = appTests.length;
  checks.apiTestCount = apiTests.length;

  // CI/CD
  const appWorkflows = globDir(join(APP_PATH, '.github', 'workflows'), /\.ya?ml$/);
  const apiWorkflows = globDir(join(API_PATH, '.github', 'workflows'), /\.ya?ml$/);
  checks.hasAppCI = appWorkflows.length > 0;
  checks.hasApiCI = apiWorkflows.length > 0;

  // Zod validation
  const routeFiles = globDir(join(API_PATH, 'src', 'app', 'api'), /route\.ts$/);
  let zodCount = 0;
  for (const f of routeFiles) {
    if (readFile(f).includes("from 'zod'") || readFile(f).includes('from "zod"')) zodCount++;
  }
  checks.zodRoutes = zodCount;
  checks.totalRoutes = routeFiles.length;

  // Cron jobs
  const vercelConfig = readFile(join(API_PATH, 'vercel.json'));
  try {
    const parsed = JSON.parse(vercelConfig);
    checks.cronJobs = parsed.crons?.length || 0;
  } catch {
    checks.cronJobs = 0;
  }

  // DB tables
  const schemaContent = readFile(join(API_PATH, 'src', 'db', 'schema.ts'));
  const tables = [...schemaContent.matchAll(/export\s+const\s+(\w+)\s*=\s*pgTable/g)].map(m => m[1]);
  checks.dbTables = tables;

  return checks;
}

// ─── 5. Calculate Percentages ─────────────────────────────

function calculatePercentages(screenData, endpointData, overrides, infra) {
  // UI: screens built vs spec'd
  const totalSpec = overrides.totalSpecScreens || 35;
  const uiPercent = Math.round((screenData.total / totalSpec) * 100);

  // UX: checklist items
  const uxItems = overrides.uxChecklist || [];
  const uxDone = uxItems.filter(i => i.done).length;
  const uxPercent = uxItems.length > 0 ? Math.round((uxDone / uxItems.length) * 100) : 0;

  // API: base coverage + CRUD penalty
  const hasCrud = endpointData.methods.PUT > 0 || endpointData.methods.DELETE > 0;
  const apiBase = Math.min(endpointData.total * 4, 100); // 25 endpoints = 100 base
  const apiPercent = Math.round(hasCrud ? apiBase : apiBase * 0.68);

  // AI: systems working
  const aiItems = overrides.aiSystems || [];
  const aiDone = aiItems.filter(i => i.done).length;
  const aiPercent = aiItems.length > 0 ? Math.round((aiDone / aiItems.length) * 100) : 0;

  // Features: weighted by status
  const statusWeights = { complete: 1.0, connected: 0.85, partial: 0.5, 'ui-only': 0.3, 'not-started': 0 };
  const features = overrides.features || [];
  let featureSum = 0;
  for (const f of features) {
    featureSum += statusWeights[f.status] || 0;
  }
  const featurePercent = features.length > 0 ? Math.round((featureSum / features.length) * 100) : 0;

  // Infra: checklist
  const infraItems = overrides.infraChecklist || [];
  const infraDone = infraItems.filter(i => i.done).length;
  const infraPercent = infraItems.length > 0 ? Math.round((infraDone / infraItems.length) * 100) : 0;

  // Overall: weighted average
  const overall = Math.round(
    uiPercent * 0.20 +
    apiPercent * 0.20 +
    featurePercent * 0.25 +
    aiPercent * 0.15 +
    uxPercent * 0.10 +
    infraPercent * 0.10
  );

  return {
    overall: { percent: overall, label: overall >= 90 ? 'Almost there' : overall >= 70 ? 'Strong progress' : overall >= 50 ? 'Building' : 'Early stage' },
    categories: {
      ui: { label: 'Screens & UI', percent: uiPercent, built: screenData.total, total: totalSpec, detail: `${screenData.total} of ${totalSpec} screens built` },
      ux: { label: 'Design & Polish', percent: uxPercent, items: uxItems, detail: `${uxDone} of ${uxItems.length} checklist items` },
      api: { label: 'Backend API', percent: apiPercent, endpoints: endpointData.methods, detail: `${endpointData.total} endpoints, ${hasCrud ? 'full CRUD' : 'no PUT/DELETE'}` },
      ai: { label: 'Intelligence', percent: aiPercent, items: aiItems, detail: `${aiDone} of ${aiItems.length} systems active` },
      features: { label: 'End-to-End Features', percent: featurePercent, detail: `${features.length} features tracked` },
      infra: { label: 'Infrastructure', percent: infraPercent, items: infraItems, detail: `${infraDone} of ${infraItems.length} items done` },
    },
  };
}

// ─── 6. Find Orphan Endpoints ─────────────────────────────

function findOrphanEndpoints(endpointData, connectivity) {
  const calledEndpoints = new Set();
  for (const entry of connectivity) {
    for (const call of entry.calls) {
      calledEndpoints.add(call.replace(/\?.*$/, '')); // strip query params
    }
  }

  const orphans = [];
  for (const ep of endpointData.endpoints) {
    // Normalize path: /api/foo/[id]/bar -> /api/foo
    const normalizedPath = ep.path.replace(/\[.*?\]/g, '').replace(/\/+$/, '');
    const isCalledFromScreen = [...calledEndpoints].some(called =>
      called.startsWith(normalizedPath) || normalizedPath.includes(called.replace('/api/', 'api/'))
    );
    // Skip cron and webhook routes — they're not called from frontend
    if (ep.path.includes('/cron/') || ep.path.includes('/webhook')) continue;
    if (ep.path.includes('/health')) continue;

    if (!isCalledFromScreen) {
      orphans.push(`${ep.path} ${ep.methods.join('/')}`);
    }
  }
  return orphans;
}

// ─── Main ─────────────────────────────────────────────────

console.log('🔍 Scanning Pause project...\n');

// Load overrides
let overrides = {};
try {
  overrides = JSON.parse(readFile(OVERRIDES_PATH));
} catch (e) {
  console.warn('⚠️  Could not load manual-overrides.json:', e.message);
}

// Run scans
const screenData = scanScreens();
console.log(`📱 Screens: ${screenData.total} built, ${screenData.missingScreens.length} missing`);

const endpointData = scanEndpoints();
console.log(`🔌 Endpoints: ${endpointData.total} (GET:${endpointData.methods.GET} POST:${endpointData.methods.POST} PUT:${endpointData.methods.PUT} DEL:${endpointData.methods.DELETE})`);

const connectivity = scanConnectivity(screenData.screens);
console.log(`🔗 Connected screens: ${connectivity.length}`);

const infra = scanInfra();
console.log(`🏗️  DB tables: ${infra.dbTables.length}, Cron jobs: ${infra.cronJobs}, Tests: app=${infra.appTestCount} api=${infra.apiTestCount}`);

const orphans = findOrphanEndpoints(endpointData, connectivity);
console.log(`⚠️  Orphan endpoints (backend only): ${orphans.length}`);

// Calculate percentages
const percentages = calculatePercentages(screenData, endpointData, overrides, infra);
console.log(`\n📊 Overall: ${percentages.overall.percent}% — ${percentages.overall.label}`);

// Git info
const appGit = gitInfo(APP_PATH);
const apiGit = gitInfo(API_PATH);
console.log(`\n🔀 App: ${appGit.sha} — ${appGit.message}`);
console.log(`🔀 API: ${apiGit.sha} — ${apiGit.message}`);

// Build output
const output = {
  generatedAt: new Date().toISOString(),
  commitInfo: {
    app: appGit,
    api: apiGit,
  },
  ...percentages,
  features: overrides.features || [],
  screens: {
    built: screenData.screens.map(s => ({ name: s.name, section: s.section })),
    missing: screenData.missingScreens,
  },
  endpoints: endpointData.endpoints,
  connectivity: {
    map: connectivity,
    orphanEndpoints: orphans,
  },
  infrastructure: infra,
};

writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
console.log(`\n✅ Dashboard data written to ${OUTPUT}`);
