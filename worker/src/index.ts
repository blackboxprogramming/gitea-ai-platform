/**
 * BlackRoad Gitea AI Platform — Cloudflare Worker
 *
 * Webhook handler for Gitea that provides:
 * - Claude-powered code review on PRs
 * - AI issue triage and labeling
 * - Auto-deploy to Railway / Cloudflare Pages on push to main
 * - Dashboard API for repo status
 */

import { dashboardHTML } from "./dashboard";

interface Env {
  GITEA_URL: string;
  GITEA_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  RAILWAY_TOKEN: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  WEBHOOK_SECRET: string;
  DEPLOY_LOG: KVNamespace;
  AI: Ai;
}

// ─── Webhook Router ───────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Dashboard
      if (url.pathname === "/dashboard") {
        return new Response(dashboardHTML(env.GITEA_URL), {
          headers: { "Content-Type": "text/html", ...corsHeaders },
        });
      }

      // Health / root
      if (url.pathname === "/" || url.pathname === "/api/health") {
        return json({ status: "ok", service: "BlackRoad Gitea AI Platform", version: "1.0.0", dashboard: "/dashboard" }, corsHeaders);
      }

      if (url.pathname === "/api/repos" && request.method === "GET") {
        return await handleListRepos(env, corsHeaders);
      }

      if (url.pathname === "/api/deploys" && request.method === "GET") {
        return await handleListDeploys(env, corsHeaders);
      }

      // Gitea Webhooks
      if (url.pathname === "/webhook/push" && request.method === "POST") {
        return await handlePush(request, env, corsHeaders);
      }

      if (url.pathname === "/webhook/pr" && request.method === "POST") {
        return await handlePullRequest(request, env, corsHeaders);
      }

      if (url.pathname === "/webhook/issue" && request.method === "POST") {
        return await handleIssue(request, env, corsHeaders);
      }

      // AI Chat endpoint — ask Claude about any repo
      if (url.pathname === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env, corsHeaders);
      }

      // Mirror GitHub repos to Gitea
      if (url.pathname === "/api/mirror" && request.method === "POST") {
        return await handleMirror(request, env, corsHeaders);
      }

      return json({ error: "Not found" }, corsHeaders, 404);
    } catch (err: any) {
      return json({ error: err.message }, corsHeaders, 500);
    }
  },
};

// ─── Helpers ──────────────────────────────────────────────────────

function json(data: any, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function giteaApi(env: Env, path: string, method = "GET", body?: any): Promise<any> {
  const res = await fetch(`${env.GITEA_URL}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `token ${env.GITEA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gitea API ${res.status}: ${text}`);
  }
  return res.json();
}

async function claudeReview(env: Env, prompt: string): Promise<string> {
  // Try Anthropic API first, fall back to Cloudflare Workers AI
  if (env.ANTHROPIC_API_KEY) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (res.ok) {
      const data: any = await res.json();
      return data.content[0].text;
    }
  }

  // Fallback: Cloudflare Workers AI
  const result: any = await env.AI.run("@cf/meta/llama-3.1-70b-instruct", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2048,
  });
  return result.response || "AI review unavailable";
}

// ─── Push Handler (Auto-Deploy) ───────────────────────────────────

async function handlePush(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const payload: any = await request.json();
  const repo = payload.repository?.full_name;
  const branch = payload.ref?.replace("refs/heads/", "");
  const commits = payload.commits || [];

  if (branch !== "main" && branch !== "master") {
    return json({ skipped: true, reason: "not default branch" }, headers);
  }

  // Log the deploy
  const deployId = crypto.randomUUID();
  const deployRecord = {
    id: deployId,
    repo,
    branch,
    commits: commits.length,
    status: "deploying",
    timestamp: new Date().toISOString(),
    commit_messages: commits.map((c: any) => c.message).slice(0, 5),
  };

  await env.DEPLOY_LOG.put(`deploy:${deployId}`, JSON.stringify(deployRecord), { expirationTtl: 86400 * 30 });
  await env.DEPLOY_LOG.put(`latest:${repo}`, JSON.stringify(deployRecord));

  // Determine deploy target from repo contents
  let deployTarget = "cloudflare"; // default
  try {
    const files = await giteaApi(env, `/repos/${repo}/contents/`);
    const fileNames = files.map((f: any) => f.name);
    if (fileNames.includes("Dockerfile") || fileNames.includes("railway.json")) {
      deployTarget = "railway";
    } else if (fileNames.includes("wrangler.toml")) {
      deployTarget = "cloudflare-worker";
    }
  } catch {}

  // Deploy
  let deployResult: string;
  if (deployTarget === "railway" && env.RAILWAY_TOKEN) {
    deployResult = await deployToRailway(env, repo);
  } else {
    deployResult = `Queued for ${deployTarget} deploy`;
  }

  deployRecord.status = "deployed";
  await env.DEPLOY_LOG.put(`deploy:${deployId}`, JSON.stringify(deployRecord), { expirationTtl: 86400 * 30 });
  await env.DEPLOY_LOG.put(`latest:${repo}`, JSON.stringify(deployRecord));

  // Comment on the last commit
  if (commits.length > 0) {
    const lastCommit = commits[commits.length - 1];
    try {
      await giteaApi(env, `/repos/${repo}/git/commits/${lastCommit.id}/statuses`, "POST", {
        state: "success",
        target_url: `https://platform.blackroad.io/deploys/${deployId}`,
        description: `Deployed to ${deployTarget}`,
        context: "blackroad/deploy",
      });
    } catch {}
  }

  return json({ deployed: true, id: deployId, target: deployTarget, result: deployResult }, headers);
}

async function deployToRailway(env: Env, repo: string): Promise<string> {
  const projectName = repo.split("/").pop();
  const res = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RAILWAY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation { deploymentTriggerCreate(input: { projectId: "${projectName}" }) { id } }`,
    }),
  });
  return res.ok ? "Railway deploy triggered" : "Railway deploy failed";
}

// ─── PR Handler (Claude Code Review) ─────────────────────────────

async function handlePullRequest(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const payload: any = await request.json();
  const action = payload.action;
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;

  if (action !== "opened" && action !== "synchronized") {
    return json({ skipped: true, reason: `action=${action}` }, headers);
  }

  // Get the diff
  const diffRes = await fetch(`${env.GITEA_URL}/api/v1/repos/${repo}/pulls/${pr.number}.diff`, {
    headers: { Authorization: `token ${env.GITEA_TOKEN}` },
  });
  const diff = await diffRes.text();

  // Truncate large diffs
  const truncatedDiff = diff.length > 12000 ? diff.substring(0, 12000) + "\n... (truncated)" : diff;

  // Claude review
  const review = await claudeReview(env, `You are a senior code reviewer for BlackRoad OS. Review this pull request diff concisely. Focus on:
1. Bugs or security issues (critical)
2. Performance concerns
3. One brief positive note

PR Title: ${pr.title}
PR Description: ${pr.body || "None"}

Diff:
\`\`\`
${truncatedDiff}
\`\`\`

Keep your review under 500 words. Use markdown. Start with a severity emoji: ✅ (looks good), ⚠️ (minor issues), 🚨 (critical issues).`);

  // Post review as comment
  await giteaApi(env, `/repos/${repo}/issues/${pr.number}/comments`, "POST", {
    body: `## 🤖 BlackRoad AI Review\n\n${review}\n\n---\n*Reviewed by Claude — [BlackRoad AI Platform](https://platform.blackroad.io)*`,
  });

  // Auto-approve if clean
  if (review.startsWith("✅")) {
    await giteaApi(env, `/repos/${repo}/pulls/${pr.number}/reviews`, "POST", {
      event: "APPROVED",
      body: "Auto-approved by BlackRoad AI — no issues found.",
    });
  }

  return json({ reviewed: true, repo, pr: pr.number }, headers);
}

// ─── Issue Handler (AI Triage) ────────────────────────────────────

async function handleIssue(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const payload: any = await request.json();
  const action = payload.action;
  const issue = payload.issue;
  const repo = payload.repository?.full_name;

  if (action !== "opened") {
    return json({ skipped: true }, headers);
  }

  // Claude triage
  const triage = await claudeReview(env, `You are an issue triage bot for BlackRoad OS. Categorize this issue and suggest labels.

Title: ${issue.title}
Body: ${issue.body || "No description"}
Repo: ${repo}

Respond with JSON only:
{
  "labels": ["bug"|"feature"|"docs"|"question"|"enhancement"],
  "priority": "low"|"medium"|"high"|"critical",
  "summary": "one line summary",
  "suggested_assignee": null
}`);

  // Parse labels and apply
  try {
    const parsed = JSON.parse(triage);
    if (parsed.labels?.length) {
      await giteaApi(env, `/repos/${repo}/issues/${issue.number}/labels`, "POST", {
        labels: parsed.labels,
      });
    }
    // Comment with triage
    await giteaApi(env, `/repos/${repo}/issues/${issue.number}/comments`, "POST", {
      body: `## 🏷️ AI Triage\n\n**Priority:** ${parsed.priority}\n**Summary:** ${parsed.summary}\n**Labels:** ${(parsed.labels || []).join(", ")}\n\n---\n*Triaged by BlackRoad AI*`,
    });
  } catch {
    // If JSON parse fails, just comment raw
    await giteaApi(env, `/repos/${repo}/issues/${issue.number}/comments`, "POST", {
      body: `## 🏷️ AI Triage\n\n${triage}\n\n---\n*Triaged by BlackRoad AI*`,
    });
  }

  return json({ triaged: true, repo, issue: issue.number }, headers);
}

// ─── Chat Endpoint ────────────────────────────────────────────────

async function handleChat(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const { message, repo } = (await request.json()) as any;

  let context = "";
  if (repo) {
    try {
      const repoInfo = await giteaApi(env, `/repos/${repo}`);
      const readme = await giteaApi(env, `/repos/${repo}/raw/README.md`).catch(() => "No README");
      context = `Repo: ${repoInfo.full_name}\nDescription: ${repoInfo.description}\nLanguage: ${repoInfo.language}\nStars: ${repoInfo.stars_count}\n\nREADME:\n${typeof readme === 'string' ? readme.substring(0, 3000) : 'N/A'}`;
    } catch {}
  }

  const response = await claudeReview(env, `You are BlackRoad AI, an assistant for the BlackRoad OS platform. You help with code, repos, and infrastructure.

${context ? `Context about the repo:\n${context}\n\n` : ""}User: ${message}`);

  return json({ response }, headers);
}

// ─── Mirror GitHub → Gitea ────────────────────────────────────────

async function handleMirror(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const { github_repo, org } = (await request.json()) as any;
  const targetOrg = org || "blackroad";

  // Create mirror repo in Gitea
  const result = await giteaApi(env, `/repos/migrate`, "POST", {
    clone_addr: `https://github.com/${github_repo}.git`,
    repo_name: github_repo.split("/").pop(),
    repo_owner: targetOrg,
    service: "github",
    mirror: true,
    description: `Mirror of github.com/${github_repo}`,
  });

  return json({ mirrored: true, gitea_repo: result.full_name, github_repo }, headers);
}

// ─── Dashboard APIs ───────────────────────────────────────────────

async function handleListRepos(env: Env, headers: Record<string, string>): Promise<Response> {
  const repos = await giteaApi(env, `/repos/search?limit=50&sort=updated`);
  const simplified = (repos.data || repos).map((r: any) => ({
    name: r.full_name,
    description: r.description,
    language: r.language,
    stars: r.stars_count,
    updated: r.updated_at,
    mirror: r.mirror,
    url: r.html_url,
  }));
  return json({ repos: simplified, count: simplified.length }, headers);
}

async function handleListDeploys(env: Env, headers: Record<string, string>): Promise<Response> {
  const list = await env.DEPLOY_LOG.list({ prefix: "deploy:" });
  const deploys = await Promise.all(
    list.keys.slice(0, 20).map(async (k) => {
      const val = await env.DEPLOY_LOG.get(k.name);
      return val ? JSON.parse(val) : null;
    })
  );
  return json({ deploys: deploys.filter(Boolean) }, headers);
}
